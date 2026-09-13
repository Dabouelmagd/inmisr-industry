// ─── suppliers/suppliers.service.ts ──────────────────────────────
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import { VerifiedLevel } from '@prisma/client';
import axios from 'axios';

// ── TRUST SCORE WEIGHTS ────────────────────────────────────────
const TRUST_WEIGHTS = {
  specMatch:    0.40,
  onTime:       0.30,
  communication:0.20,
  noDispute:    0.10,
};

@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // ── LIST SUPPLIERS ─────────────────────────────────────────────
  async findAll(query: SupplierQueryDto) {
    const where: any = {
      type: 'SUPPLIER',
      verifiedLevel: { not: 'NONE' },
    };

    if (query.sector)         where.categories = { some: { category: { sectorCode: query.sector } } };
    if (query.city)           where.location   = { city: { contains: query.city } };
    if (query.zone)           where.location   = { industrialZone: { contains: query.zone } };
    if (query.verifiedLevel)  where.verifiedLevel = query.verifiedLevel;
    if (query.minRating)      where.avgRating  = { gte: query.minRating };
    if (query.minTrustScore)  where.trustScore = { gte: query.minTrustScore };

    // Geo-radius filter (PostGIS)
    let geoIds: string[] | undefined;
    if (query.lat && query.lng && query.radiusKm) {
      geoIds = await this.findInRadius(query.lat, query.lng, query.radiusKm);
      where.id = { in: geoIds };
    }

    const orderBy = this.buildOrderBy(query.sortBy);
    const page = Number(query.page) || 1;
    const take = Number(query.limit) || 20;
    const skip = (page - 1) * take;

    const [data, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        include: {
          location: { select: { city: true, governorate: true, industrialZone: true, lat: true, lng: true } },
          categories: { include: { category: { select: { nameAr: true, sectorCode: true } } } },
          subscription: { select: { plan: true } },
          _count: { select: { products: true, reviewsReceived: true } },
        },
        orderBy,
        skip,
        take,
      }),
      this.prisma.company.count({ where }),
    ]);

    // Add distance if geo query, and strip admin-only contact fields
    // (contactPhone is real business contact info -- public/other-company
    // views never see it, only the admin factories/suppliers listings do).
    const enriched = data.map(s => {
      const { contactPhone, ...pub } = s as any;
      return geoIds && query.lat && query.lng
        ? { ...pub, distanceKm: pub.location ? this.haversine(query.lat!, query.lng!, pub.location.lat, pub.location.lng) : null }
        : pub;
    });

    return {
      data: enriched,
      pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  // ── GET SINGLE SUPPLIER ────────────────────────────────────────
  async findOne(id: string, viewerCompanyId?: string) {
    const supplier = await this.prisma.company.findUnique({
      where: { id, type: 'SUPPLIER' },
      include: {
        location: { select: { city: true, governorate: true, industrialZone: true, lat: true, lng: true } },
        categories: { include: { category: true } },
        subscription: true,
        products: {
          where: { isActive: true },
          include: { category: true },
          orderBy: { views: 'desc' },
          take: 20,
        },
        reviewsReceived: {
          include: { reviewer: { select: { nameAr: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        verifications: {
          select: { docType: true, status: true, reviewedAt: true },
        },
        _count: {
          select: { ordersAsSupplier: true, reviewsReceived: true, products: true },
        },
      },
    });

    if (!supplier) throw new NotFoundException('المورد غير موجود');

    // contactPhone is a real business contact number, but this is a
    // public/other-company-facing view -- keep it admin-only (see
    // AdminService.listFactories / a future listSuppliersAdmin).
    const { contactPhone, ...publicSupplier } = supplier as any;

    // Log view for analytics
    await this.prisma.auditLog.create({
      data: {
        action: 'VIEW_SUPPLIER',
        entity: 'Company',
        entityId: id,
        userId: viewerCompanyId,
      },
    }).catch(() => {});

    return publicSupplier;
  }

  // ── SUBMIT VERIFICATION DOCS ───────────────────────────────────
  async submitVerification(companyId: string, dto: VerificationDto) {
    const verif = await this.prisma.verification.create({
      data: {
        companyId,
        docType: dto.docType,
        fileUrlEnc: dto.fileUrl, // In prod: encrypt with AES-256
        status: 'PENDING',
      },
    });

    // Trigger async OCR + AI verification
    this.processOcrAsync(verif.id, dto.fileUrl, dto.docType);

    return { message: 'تم رفع الوثيقة بنجاح — سيتم مراجعتها خلال ٤٨ ساعة', verificationId: verif.id };
  }

  // ── OCR PROCESSING (Async) ─────────────────────────────────────
  private async processOcrAsync(verifId: string, fileUrl: string, docType: string) {
    try {
      // AWS Textract
      const textractResult = await this.runTextract(fileUrl);

      // Validate against government APIs
      const validationResult = await this.validateDocument(docType, textractResult);

      await this.prisma.verification.update({
        where: { id: verifId },
        data: {
          ocrDataJson: textractResult,
          status: validationResult.valid ? 'VERIFIED' : 'UNDER_REVIEW',
          reviewedAt: validationResult.valid ? new Date() : null,
        },
      });

      // If all basic docs verified → upgrade level
      if (validationResult.valid) {
        await this.checkAndUpgradeLevel(
          (await this.prisma.verification.findUnique({ where: { id: verifId } }))!.companyId
        );
      }

      this.logger.log(`OCR complete for verif ${verifId}: ${validationResult.valid ? '✓' : '⏳'}`);
    } catch (err) {
      this.logger.error(`OCR failed for ${verifId}`, err.message);
    }
  }

  private async runTextract(fileUrl: string): Promise<any> {
    // AWS Textract SDK call
    return { text: 'OCR result placeholder', confidence: 0.95, fields: {} };
  }

  private async validateDocument(docType: string, ocrData: any): Promise<{ valid: boolean }> {
    // Validate against GAFI API, Tax Authority API, etc.
    return { valid: true };
  }

  // ── RECALCULATE TRUST SCORE ────────────────────────────────────
  async recalculateTrustScore(companyId: string): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: { supplierCompanyId: companyId, status: { in: ['CONFIRMED', 'DISPUTED'] } },
      include: { review: true, dispute: true },
    });

    if (orders.length === 0) return 0;

    const completed = orders.filter(o => o.status === 'CONFIRMED').length;
    const disputed  = orders.filter(o => o.status === 'DISPUTED').length;
    const reviews   = orders.filter(o => o.review).map(o => o.review!);

    const avgSpec    = reviews.length ? reviews.reduce((a, r) => a + r.qualityScore, 0) / reviews.length : 75;
    const avgTime    = reviews.length ? reviews.reduce((a, r) => a + r.timeScore, 0) / reviews.length : 75;
    const avgComm    = reviews.length ? reviews.reduce((a, r) => a + r.commScore, 0) / reviews.length : 75;
    const disputeRate = orders.length ? (disputed / orders.length) * 100 : 0;
    const noDisputeScore = Math.max(0, 100 - disputeRate * 10);

    const score = Math.round(
      (avgSpec * 20)     * TRUST_WEIGHTS.specMatch +
      (avgTime * 20)     * TRUST_WEIGHTS.onTime +
      (avgComm * 20)     * TRUST_WEIGHTS.communication +
      noDisputeScore     * TRUST_WEIGHTS.noDispute
    );

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        trustScore: Math.min(100, score),
        specMatchRate: avgSpec,
        onTimeRate: avgTime,
        disputeRate: disputed / Math.max(1, orders.length),
        totalDeals: completed,
      },
    });

    return score;
  }

  // ── CHECK & UPGRADE VERIFICATION LEVEL ────────────────────────
  private async checkAndUpgradeLevel(companyId: string) {
    const verifs = await this.prisma.verification.findMany({
      where: { companyId, status: 'VERIFIED' },
    });

    const types = new Set(verifs.map(v => v.docType));
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return;

    let newLevel: VerifiedLevel = company.verifiedLevel;

    // Basic: commercial reg + tax ID
    if (types.has('COMMERCIAL_REG') && types.has('TAX_ID')) {
      newLevel = VerifiedLevel.BASIC;
    }
    // Certified: + 3 work references + quality cert
    if (newLevel === VerifiedLevel.BASIC && types.has('WORK_REFERENCE') && types.has('QUALITY_CERT')) {
      newLevel = VerifiedLevel.CERTIFIED;
    }
    // Elite: + field visit + trust score ≥ 85 + 50 deals
    if (
      newLevel === VerifiedLevel.CERTIFIED &&
      types.has('FIELD_VISIT') &&
      (company.trustScore || 0) >= 85 &&
      (company.totalDeals || 0) >= 50
    ) {
      newLevel = VerifiedLevel.ELITE;
    }

    if (newLevel !== company.verifiedLevel) {
      await this.prisma.company.update({ where: { id: companyId }, data: { verifiedLevel: newLevel } });
      this.logger.log(`Company ${companyId} upgraded to ${newLevel}`);
    }
  }

  // ── GEO HELPERS ───────────────────────────────────────────────
  private async findInRadius(lat: number, lng: number, radiusKm: number): Promise<string[]> {
    // PostGIS query via raw SQL
    const results = await this.prisma.$queryRaw<{ company_id: string }[]>`
      SELECT g.company_id
      FROM geo_locations g
      WHERE (
        6371 * acos(
          cos(radians(${lat})) * cos(radians(g.lat)) *
          cos(radians(g.lng) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(g.lat))
        )
      ) <= ${radiusKm}
    `;
    return results.map(r => r.company_id);
  }

  haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return +(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }

  private buildOrderBy(sortBy?: string) {
    switch (sortBy) {
      case 'rating':      return { avgRating: 'desc' as const };
      case 'trust':       return { trustScore: 'desc' as const };
      case 'deals':       return { totalDeals: 'desc' as const };
      case 'response':    return { avgResponseHours: 'asc' as const };
      case 'newest':      return { createdAt: 'desc' as const };
      default:            return { trustScore: 'desc' as const };
    }
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────
import { IsString, IsNumber, IsOptional, IsEnum, Min, Max, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { VerifiedLevel as VL } from '@prisma/client';
import { Type } from 'class-transformer';

export class SupplierQueryDto {
  @IsString() @IsOptional() sector?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() zone?: string;
  @IsEnum(VL) @IsOptional() verifiedLevel?: VL;
  @Type(() => Number) @IsNumber() @Min(1) @Max(5) @IsOptional() minRating?: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) @IsOptional() minTrustScore?: number;
  @Type(() => Number) @IsNumber() @IsOptional() lat?: number;
  @Type(() => Number) @IsNumber() @IsOptional() lng?: number;
  @Type(() => Number) @IsNumber() @Min(1) @Max(500) @IsOptional() radiusKm?: number;
  @IsString() @IsOptional() sortBy?: string;
  @Type(() => Number) @IsNumber() @IsOptional() page?: number;
  @Type(() => Number) @IsNumber() @IsOptional() limit?: number;
}

export class VerificationDto {
  @ApiProperty({ example: 'COMMERCIAL_REG' })
  @IsString() docType: string;
  @ApiProperty({ example: 'https://s3.amazonaws.com/bucket/doc.pdf' })
  @IsUrl() fileUrl: string;
}
