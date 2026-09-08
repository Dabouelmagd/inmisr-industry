// ─── search/search.controller.ts ─────────────────────────────────
import {
  Controller, Get, Post, Query, Body, UseGuards, Request,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService }  from './search.service';
import { JwtGuard, Public, Roles } from '../auth/jwt.guard';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private search: SearchService) {}

  @Get('suppliers')
  @Public()
  @ApiOperation({ summary: 'بحث متقدم في الموردين — Elasticsearch مع Arabic analyzer' })
  @ApiQuery({ name: 'query', required: false, description: 'نص البحث' })
  @ApiQuery({ name: 'sector', required: false, description: 'كود القطاع' })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'verifiedLevel', required: false, enum: ['NONE','BASIC','CERTIFIED','ELITE'] })
  @ApiQuery({ name: 'minRating', required: false, type: Number })
  @ApiQuery({ name: 'minTrustScore', required: false, type: Number })
  @ApiQuery({ name: 'lat', required: false, type: Number })
  @ApiQuery({ name: 'lng', required: false, type: Number })
  @ApiQuery({ name: 'radiusKm', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['trust','rating','deals','newest','response'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  searchSuppliers(@Query() q: {
    query?: string; sector?: string; city?: string;
    verifiedLevel?: string; minRating?: number; minTrustScore?: number;
    lat?: number; lng?: number; radiusKm?: number;
    sortBy?: string; page?: number; limit?: number;
  }) {
    // Parse numeric query params (come as strings from URL)
    return this.search.searchSuppliers({
      ...q,
      minRating:     q.minRating     ? +q.minRating     : undefined,
      minTrustScore: q.minTrustScore ? +q.minTrustScore : undefined,
      lat:           q.lat           ? +q.lat           : undefined,
      lng:           q.lng           ? +q.lng           : undefined,
      radiusKm:      q.radiusKm      ? +q.radiusKm      : undefined,
      page:          q.page          ? +q.page          : 1,
      limit:         q.limit         ? +q.limit         : 20,
    });
  }

  @Get('autocomplete')
  @Public()
  @ApiOperation({ summary: 'اقتراحات بحث فورية (autocomplete)' })
  autocomplete(@Query('q') q: string, @Query('type') type?: 'supplier' | 'product' | 'sector') {
    if (!q || q.length < 2) return { suggestions: [] };
    return this.search.searchSuppliers({ query: q, limit: 5 });
  }

  @Post('reindex')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: '[Admin] إعادة فهرسة جميع الموردين في Elasticsearch' })
  async reindexAll() {
    await this.search.reindexAll();
    return { message: 'تمت إعادة الفهرسة بنجاح' };
  }
}

// ─── maps/maps.controller.ts ──────────────────────────────────────
import { Param } from '@nestjs/common';
import { MapsService } from '../geo/maps.service';

@ApiTags('maps')
@Controller('maps')
export class MapsController {
  constructor(private maps: MapsService) {}

  @Get('geocode')
  @Public()
  @ApiOperation({ summary: 'تحويل عنوان نصي إلى إحداثيات GPS' })
  geocode(@Query('address') address: string) {
    if (!address) return { error: 'address is required' };
    return this.maps.geocode(address);
  }

  @Get('reverse-geocode')
  @Public()
  @ApiOperation({ summary: 'تحويل إحداثيات GPS إلى عنوان' })
  reverseGeocode(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
  ) {
    return this.maps.reverseGeocode(parseFloat(lat), parseFloat(lng));
  }

  @Get('route')
  @Public()
  @ApiOperation({ summary: 'مسار ووقت بين موقعين (للشحن)' })
  getRoute(
    @Query('fromLat') fLat: string, @Query('fromLng') fLng: string,
    @Query('toLat')   tLat: string, @Query('toLng')   tLng: string,
  ) {
    return this.maps.getRoute(
      { lat: +fLat, lng: +fLng },
      { lat: +tLat, lng: +tLng },
    );
  }

  @Get('autocomplete')
  @Public()
  @ApiOperation({ summary: 'اقتراحات أماكن مصرية (Google Places)' })
  autocomplete(@Query('q') q: string) {
    if (!q || q.length < 2) return { predictions: [] };
    return this.maps.autocomplete(q);
  }

  @Get('nearby-suppliers')
  @Public()
  @ApiOperation({ summary: 'موردون في نطاق جغرافي محدد (km)' })
  nearby(
    @Query('lat')    lat:    string,
    @Query('lng')    lng:    string,
    @Query('radius') radius: string,
    @Query('sector') sector?: string,
  ) {
    return this.maps.findSuppliersNear(+lat, +lng, +(radius || 50), sector);
  }

  @Post('update-location/:companyId')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تحديث موقع شركة (geocode من العنوان)' })
  updateLocation(@Param('companyId') id: string, @Body() body: { address: string }) {
    return this.maps.updateCompanyLocation(id, body.address);
  }
}

// ─── common/request-id.middleware.ts ──────────────────────────────
// Middleware يضيف Request ID لكل طلب للـ tracing
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request as ExpressRequest, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: ExpressRequest, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    (req as any).requestId = requestId;
    next();
  }
}

// ─── config/sentry.config.ts ──────────────────────────────────────
// Sentry error monitoring setup
export async function initSentry(dsn: string, env: string): Promise<void> {
  if (!dsn) return;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: env,
      tracesSampleRate: env === 'production' ? 0.1 : 1.0,
      beforeSend(event) {
        // Strip PII from error reports
        if (event.user) {
          delete event.user.email;
          delete event.user.ip_address;
        }
        return event;
      },
    });
  } catch {
    console.warn('Sentry not available — error monitoring disabled');
  }
}

// ─── prisma/seed.demo.ts ──────────────────────────────────────────
// بيانات تجريبية للـ staging — موردون وطلبات ومراجعات نموذجية
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_SUPPLIERS = [
  { nameAr: 'حديد مصر للتجارة',       nameEn: 'Hadid Misr Trading',    sector: 'iron_steel',      city: 'العاشر من رمضان', trustScore: 94, rating: 4.9, deals: 345 },
  { nameAr: 'مصانع النصر للبتروكيماويات', nameEn: 'Nasr Petrochemicals',  sector: 'petrochemicals',  city: '٦ أكتوبر',        trustScore: 87, rating: 4.6, deals: 212 },
  { nameAr: 'طاقة مصر الشمسية',        nameEn: 'Taqa Misr Solar',       sector: 'solar',           city: 'العبور',           trustScore: 91, rating: 5.0, deals: 178 },
  { nameAr: 'مصنع الوادي للصناعات الغذائية', nameEn: 'Wadi Food Factory', sector: 'food',           city: 'السادات',          trustScore: 79, rating: 4.3, deals: 134 },
  { nameAr: 'الشركة المصرية للألومنيوم', nameEn: 'Egyptian Aluminium Co', sector: 'aluminum',        city: 'برج العرب',        trustScore: 88, rating: 4.7, deals: 267 },
  { nameAr: 'مصر للكيماويات الصناعية',  nameEn: 'Misr Industrial Chem',  sector: 'petrochemicals',  city: 'العاشر من رمضان', trustScore: 82, rating: 4.4, deals: 156 },
  { nameAr: 'النيل لمعدات الري',        nameEn: 'Nile Irrigation Equip', sector: 'pumps_motors',    city: 'القاهرة',          trustScore: 76, rating: 4.1, deals: 98  },
  { nameAr: 'مصانع الدلتا للنسيج',      nameEn: 'Delta Textile Mills',   sector: 'textile',         city: 'المحلة الكبرى',   trustScore: 85, rating: 4.5, deals: 189 },
];

const DEMO_BUYERS = [
  { nameAr: 'مصنع المستقبل للبناء',    city: 'العاشر من رمضان' },
  { nameAr: 'شركة النيل للإنشاءات',    city: 'القاهرة' },
  { nameAr: 'مصنع ستار للبلاستيك',    city: '٦ أكتوبر' },
  { nameAr: 'الشركة العربية للتعبئة',   city: 'الإسكندرية' },
];

async function seedDemo() {
  console.log('\n🎭 Seeding demo/staging data...');

  const hash = await bcrypt.hash('Demo@12345!', 12);
  const ironCat = await prisma.category.findUnique({ where: { sectorCode: 'iron_steel' } });

  // Create demo suppliers
  for (const [i, s] of DEMO_SUPPLIERS.entries()) {
    const email = `supplier${i + 1}@demo.inmisr.net`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) continue;

    const cat = await prisma.category.findUnique({ where: { sectorCode: s.sector } });

    await prisma.user.create({
      data: {
        email,
        emailVerified: true,
        passwordHash: hash,
        role: 'SUPPLIER',
        kycStatus: 'VERIFIED',
        company: {
          create: {
            nameAr: s.nameAr, nameEn: s.nameEn,
            type: 'SUPPLIER',
            verifiedLevel: s.trustScore >= 90 ? 'ELITE' : s.trustScore >= 80 ? 'CERTIFIED' : 'BASIC',
            trustScore: s.trustScore,
            avgRating: s.rating,
            totalReviews: Math.floor(s.deals * 0.7),
            totalDeals: s.deals,
            avgResponseHours: Math.floor(Math.random() * 24 + 12),
            subscription: { create: { plan: s.trustScore >= 90 ? 'ELITE' : 'GROWTH' } },
            location: {
              create: {
                city: s.city, governorate: s.city,
                industrialZone: s.city,
                lat: 30.0444 + (Math.random() - 0.5) * 2,
                lng: 31.2357 + (Math.random() - 0.5) * 2,
              },
            },
            categories: cat ? { create: { categoryId: cat.id } } : undefined,
          },
        },
      },
    });
  }

  // Create demo buyers
  for (const [i, b] of DEMO_BUYERS.entries()) {
    const email = `buyer${i + 1}@demo.inmisr.net`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) continue;

    await prisma.user.create({
      data: {
        email, emailVerified: true, passwordHash: hash,
        role: 'BUYER', kycStatus: 'VERIFIED',
        company: {
          create: {
            nameAr: b.nameAr, type: 'BUYER', verifiedLevel: 'BASIC',
            subscription: { create: { plan: 'FREE' } },
            location: { create: { city: b.city, governorate: b.city, lat: 30.05, lng: 31.25 } },
          },
        },
      },
    });
  }

  // Create a sample published RFQ
  const buyer = await prisma.user.findUnique({ where: { email: 'buyer1@demo.inmisr.net' }, include: { company: true } });
  if (buyer?.company && ironCat) {
    await prisma.rfqRequest.create({
      data: {
        buyerCompanyId: buyer.company.id,
        categoryId:     ironCat.id,
        templateType:   'iron_steel',
        specsJson: { alloy_grade: 'AISI 1020', thickness_mm: 25, finish: 'Hot Rolled', form: 'تسليح' },
        quantity:     120, unit: 'طن',
        deadline:     new Date(Date.now() + 7 * 86400000),
        deliveryAddress: 'المنطقة الصناعية — العاشر من رمضان',
        deliveryCity:  'العاشر من رمضان',
        paymentMethod: 'ESCROW',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
  }

  const supplierCount = await prisma.company.count({ where: { type: 'SUPPLIER' } });
  const buyerCount    = await prisma.company.count({ where: { type: 'BUYER' } });
  console.log(`✅ Demo data: ${supplierCount} suppliers, ${buyerCount} buyers`);
  console.log('\nDemo logins:');
  console.log('  Supplier: supplier1@demo.inmisr.net / Demo@12345!');
  console.log('  Buyer:    buyer1@demo.inmisr.net    / Demo@12345!');
}

seedDemo()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
