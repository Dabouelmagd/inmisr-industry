// ─── search/search.service.ts ─────────────────────────────────────
// Elasticsearch 8 — Arabic + English full-text search
// Indexes: suppliers, products, rfq_requests

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import type { MappingTypeMapping, IndicesIndexSettings } from '@elastic/elasticsearch/lib/api/types';
import { PrismaService } from '../common/prisma.service';

// ── INDEX DEFINITIONS ─────────────────────────────────────────────
const INDEXES = {
  SUPPLIERS: 'inmisr-suppliers',
  PRODUCTS:  'inmisr-products',
  RFQS:      'inmisr-rfqs',
} as const;

const SUPPLIERS_MAPPING: MappingTypeMapping = {
  properties: {
    id:            { type: 'keyword' },
    nameAr:        { type: 'text', analyzer: 'arabic_analyzer' },
    nameEn:        { type: 'text', analyzer: 'english' },
    descriptionAr: { type: 'text', analyzer: 'arabic_analyzer' },
    city:          { type: 'keyword' },
    industrialZone:{ type: 'keyword' },
    sectors:       { type: 'keyword' },
    verifiedLevel: { type: 'keyword' },
    trustScore:    { type: 'integer' },
    avgRating:     { type: 'float'   },
    totalDeals:    { type: 'integer' },
    avgResponseHours: { type: 'integer' },
    lat:           { type: 'float' },
    lng:           { type: 'float' },
    location:      { type: 'geo_point' },
    plan:          { type: 'keyword' },
    tags:          { type: 'text', analyzer: 'arabic_analyzer' },
    createdAt:     { type: 'date' },
    updatedAt:     { type: 'date' },
  },
};

const PRODUCTS_MAPPING: MappingTypeMapping = {
  properties: {
    id:         { type: 'keyword' },
    companyId:  { type: 'keyword' },
    nameAr:     { type: 'text', analyzer: 'arabic_analyzer', boost: 3 },
    nameEn:     { type: 'text', analyzer: 'english', boost: 2 },
    specsText:  { type: 'text', analyzer: 'arabic_analyzer' },
    sectorCode: { type: 'keyword' },
    unit:       { type: 'keyword' },
    priceMin:   { type: 'float' },
    priceMax:   { type: 'float' },
    createdAt:  { type: 'date' },
  },
};

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  private client: Client;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.client = new Client({
      node: this.config.get('ELASTIC_URL', 'http://localhost:9200'),
      auth: { username: 'elastic', password: this.config.get('ELASTIC_PASSWORD', '') },
    });

    try {
      await this.client.ping();
      this.logger.log('Elasticsearch connected ✓');
      await this.ensureIndexes();
    } catch (err) {
      this.logger.warn('Elasticsearch not available — search degraded to PostgreSQL');
    }
  }

  // ── ENSURE INDEXES WITH ARABIC ANALYZER ──────────────────────
  private async ensureIndexes() {
    const SETTINGS: IndicesIndexSettings = {
      analysis: {
        analyzer: {
          arabic_analyzer: {
            type:      'custom',
            tokenizer: 'standard',
            filter:    ['lowercase', 'arabic_normalization', 'arabic_stop', 'arabic_stemmer'],
          },
          arabic_search_analyzer: {
            type:      'custom',
            tokenizer: 'standard',
            filter:    ['lowercase', 'arabic_normalization', 'arabic_stop'],
          },
        },
        filter: {
          arabic_stop:    { type: 'stop',         stopwords: '_arabic_' },
          arabic_stemmer: { type: 'stemmer',      language:  'arabic'   },
          arabic_normalization: { type: 'arabic_normalization' },
        },
      },
    };

    for (const [name, index] of Object.entries(INDEXES)) {
      const exists = await this.client.indices.exists({ index });
      if (!exists) {
        await this.client.indices.create({
          index,
          settings: SETTINGS,
          mappings: name === 'SUPPLIERS'
            ? SUPPLIERS_MAPPING
            : name === 'PRODUCTS'
            ? PRODUCTS_MAPPING
            : undefined,
        });
        this.logger.log(`Created ES index: ${index}`);
      }
    }
  }

  // ── SEARCH SUPPLIERS ──────────────────────────────────────────
  async searchSuppliers(q: {
    query?:         string;
    sector?:        string;
    city?:          string;
    verifiedLevel?: string;
    minRating?:     number;
    minTrustScore?: number;
    lat?:           number;
    lng?:           number;
    radiusKm?:      number;
    sortBy?:        string;
    page?:          number;
    limit?:         number;
  }) {
    const from  = ((q.page || 1) - 1) * (q.limit || 20);
    const size  = q.limit || 20;
    const must:  any[] = [];
    const filter: any[] = [];

    // Full-text search
    if (q.query) {
      must.push({
        multi_match: {
          query:     q.query,
          fields:    ['nameAr^3', 'nameEn^2', 'descriptionAr', 'tags'],
          analyzer:  'arabic_search_analyzer',
          fuzziness: 'AUTO',
          type:      'best_fields',
        },
      });
    }

    // Filters
    if (q.sector)        filter.push({ term: { sectors: q.sector } });
    if (q.city)          filter.push({ term: { city: q.city } });
    if (q.verifiedLevel) filter.push({ term: { verifiedLevel: q.verifiedLevel } });
    if (q.minRating)     filter.push({ range: { avgRating:   { gte: q.minRating   } } });
    if (q.minTrustScore) filter.push({ range: { trustScore:  { gte: q.minTrustScore } } });

    // Geo-distance filter
    if (q.lat && q.lng && q.radiusKm) {
      filter.push({
        geo_distance: {
          distance: `${q.radiusKm}km`,
          location: { lat: q.lat, lon: q.lng },
        },
      });
    }

    // Sort
    const sort: any[] = [];
    if (q.query) {
      sort.push({ _score: 'desc' });
    }
    // Boost paid plans
    const functionScore = q.lat && q.lng ? {
      function_score: {
        query: { bool: { must: must.length ? must : [{ match_all: {} }], filter } },
        functions: [
          { filter: { term: { plan: 'ELITE' } },  weight: 5 },
          { filter: { term: { plan: 'GROWTH' } }, weight: 2 },
          { gauss: { location: { origin: `${q.lat},${q.lng}`, scale: '20km', decay: 0.5 } } },
        ],
        score_mode: 'sum',
        boost_mode: 'multiply',
      },
    } : undefined;

    const body: any = functionScore || { bool: { must: must.length ? must : [{ match_all: {} }], filter } };

    try {
      const result = await this.client.search({
        index: INDEXES.SUPPLIERS,
        from, size,
        query: body,
        sort:  sort.length ? sort : [{ trustScore: 'desc' }, { avgRating: 'desc' }],
        highlight: q.query ? {
          fields: { nameAr: {}, nameEn: {}, descriptionAr: {} },
          pre_tags:  ['<mark>'],
          post_tags: ['</mark>'],
        } : undefined,
      });

      return {
        data:       result.hits.hits.map(h => ({ ...(h._source as Record<string, unknown>), _score: h._score, _highlight: h.highlight })),
        total:      typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0,
        page:       q.page || 1,
        limit:      size,
        totalPages: Math.ceil((typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0) / size),
      };
    } catch (err) {
      this.logger.warn(`ES search failed, falling back to Prisma: ${err.message}`);
      return this.fallbackSearch(q);
    }
  }

  // ── INDEX / UPDATE A SUPPLIER ─────────────────────────────────
  async indexSupplier(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        location: true,
        categories: { include: { category: true } },
        subscription: true,
      },
    });

    if (!company) return;

    await this.client.index({
      index:   INDEXES.SUPPLIERS,
      id:      companyId,
      document: {
        id:               company.id,
        nameAr:           company.nameAr,
        nameEn:           company.nameEn || '',
        descriptionAr:    company.descriptionAr || '',
        city:             company.location?.city || '',
        industrialZone:   company.location?.industrialZone || '',
        sectors:          company.categories.map(c => c.category.sectorCode),
        verifiedLevel:    company.verifiedLevel,
        trustScore:       company.trustScore,
        avgRating:        company.avgRating,
        totalDeals:       company.totalDeals,
        avgResponseHours: company.avgResponseHours,
        lat:              company.location?.lat,
        lng:              company.location?.lng,
        location:         company.location ? { lat: company.location.lat, lon: company.location.lng } : null,
        plan:             company.subscription?.plan || 'FREE',
        createdAt:        company.createdAt,
        updatedAt:        company.updatedAt,
      },
    });
  }

  // ── BULK RE-INDEX ─────────────────────────────────────────────
  async reindexAll() {
    this.logger.log('Starting full re-index...');
    const companies = await this.prisma.company.findMany({
      where: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } },
      select: { id: true },
    });

    const BATCH = 50;
    for (let i = 0; i < companies.length; i += BATCH) {
      const batch = companies.slice(i, i + BATCH);
      await Promise.all(batch.map(c => this.indexSupplier(c.id)));
      this.logger.log(`Re-indexed ${Math.min(i + BATCH, companies.length)}/${companies.length}`);
    }

    this.logger.log('Re-index complete');
  }

  // ── FALLBACK TO PRISMA if ES unavailable ──────────────────────
  private async fallbackSearch(q: any) {
    const where: any = { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } };
    if (q.query)        where.OR = [{ nameAr: { contains: q.query } }, { nameEn: { contains: q.query } }];
    if (q.sector)       where.categories = { some: { category: { sectorCode: q.sector } } };
    if (q.city)         where.location   = { city: { contains: q.city } };
    if (q.minRating)    where.avgRating  = { gte: q.minRating };
    if (q.minTrustScore) where.trustScore = { gte: q.minTrustScore };

    const [data, total] = await Promise.all([
      this.prisma.company.findMany({ where, include: { location: true }, take: q.limit || 20, skip: ((q.page || 1) - 1) * (q.limit || 20) }),
      this.prisma.company.count({ where }),
    ]);

    return { data, total, page: q.page || 1, limit: q.limit || 20, totalPages: Math.ceil(total / (q.limit || 20)), fallback: true };
  }
}
