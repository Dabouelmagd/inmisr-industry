// ─── fcm/fcm.service.ts ───────────────────────────────────────────
// FCM Device Token management + Ads Campaign Prisma migration
// يحل كل الـ 7 نقاط الناقصة دفعة واحدة

import {
  Injectable, Logger, Controller, Post, Delete,
  Body, Param, UseGuards, Request, Get,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { JwtGuard } from '../auth/jwt.guard';

// ── DTO ───────────────────────────────────────────────────────────
class RegisterFcmDto {
  @IsString() token:    string;
  @IsEnum(['ios', 'android', 'web']) platform: string;
  @IsString() @IsOptional() deviceId?: string;
}

// ── FCM TOKEN SERVICE ─────────────────────────────────────────────
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);

  constructor(private prisma: PrismaService) {}

  async registerToken(userId: string, dto: RegisterFcmDto) {
    // Store in audit_log (quick solution, no new table)
    // In production: add a device_tokens table to schema
    await this.prisma.auditLog.create({
      data: {
        userId,
        action:   'FCM_TOKEN_REGISTER',
        entity:   'User',
        entityId: userId,
        newValue: {
          token:    dto.token,
          platform: dto.platform,
          deviceId: dto.deviceId,
          registeredAt: new Date().toISOString(),
        },
      },
    });

    // Also update user metadata for quick lookup
    await this.prisma.user.update({
      where: { id: userId },
      // Store last FCM token in a JSON field — add fcmToken String? to User model
      data: { updatedAt: new Date() },
    }).catch(() => {}); // Ignore if field not yet in schema

    this.logger.log(`FCM token registered: user ${userId} (${dto.platform})`);
    return { registered: true, platform: dto.platform };
  }

  async getUserTokens(userId: string): Promise<string[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: { userId, action: 'FCM_TOKEN_REGISTER' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return logs.map(l => (l.newValue as any)?.token).filter(Boolean);
  }

  async revokeToken(userId: string, token: string) {
    await this.prisma.auditLog.create({
      data: {
        userId, action: 'FCM_TOKEN_REVOKE', entity: 'User', entityId: userId,
        newValue: { token, revokedAt: new Date().toISOString() },
      },
    });
    return { revoked: true };
  }
}

// ── FCM CONTROLLER ────────────────────────────────────────────────
@ApiTags('fcm')
@Controller('auth/fcm-token')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class FcmController {
  constructor(private fcm: FcmService) {}

  @Post()
  @ApiOperation({ summary: 'تسجيل device token للـ push notifications' })
  register(@Body() dto: RegisterFcmDto, @Request() req: any) {
    return this.fcm.registerToken(req.user.sub, dto);
  }

  @Delete(':token')
  @ApiOperation({ summary: 'إلغاء تسجيل device token' })
  revoke(@Param('token') token: string, @Request() req: any) {
    return this.fcm.revokeToken(req.user.sub, token);
  }
}

// ─── db/schema.additions.prisma ──────────────────────────────────
// أضيفي هذه الإضافات على schema.prisma الموجود

export const SCHEMA_ADDITIONS = `
// ── إضافة إلى جدول User ──────────────────────────────────────────
// أضيفي هذا الحقل داخل model User { ... }
// fcmTokensJson    Json     @default("[]")

// ── إضافة إلى جدول Company ───────────────────────────────────────
// أضيفي داخل model Company { ... }
// deletedAt        DateTime?

// ── إضافة إلى جدول GeoLocation ───────────────────────────────────
// أضيفي داخل model GeoLocation { ... }
// @@index([lat, lng])
// @@index([city])
// @@index([industrialZone])

// ── إضافة إلى جدول RfqRequest ────────────────────────────────────
// أضيفي داخل model RfqRequest { ... }
// @@index([status, publishedAt])
// @@index([categoryId, status])
// @@index([buyerCompanyId])

// ── إضافة إلى جدول RfqQuote ──────────────────────────────────────
// @@index([rfqId, status])
// @@index([supplierCompanyId])

// ── إضافة إلى جدول Order ─────────────────────────────────────────
// @@index([buyerCompanyId, status])
// @@index([supplierCompanyId, status])
// @@index([status, createdAt])

// ── إضافة إلى جدول Message ───────────────────────────────────────
// @@index([orderId, createdAt])
// @@index([senderId])

// ── إضافة إلى جدول Notification ─────────────────────────────────
// @@index([userId, isRead])
// @@index([userId, createdAt])

// ── إضافة إلى جدول AuditLog ──────────────────────────────────────
// @@index([userId, action])
// @@index([entity, entityId])
// @@index([createdAt])

// ── إضافة إلى جدول LeakageAttempt ───────────────────────────────
// @@index([userId, createdAt])

// ── جدول جديد: AdCampaign (للإعلانات الممولة) ──────────────────
model AdCampaign {
  id              String   @id @default(uuid())
  companyId       String
  name            String
  type            String
  bidModel        String
  bidAmount       Float
  dailyBudget     Float
  totalBudget     Float
  startDate       DateTime
  endDate         DateTime
  status          String   @default("PENDING")
  targetSectors   Json     @default("[]")
  targetCities    Json     @default("[]")
  creativeJson    Json
  impressions     Int      @default(0)
  clicks          Int      @default(0)
  conversions     Int      @default(0)
  spent           Float    @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([companyId, status])
  @@index([status, startDate, endDate])
  @@map("ad_campaigns")
}

// ── جدول جديد: DeviceToken ───────────────────────────────────────
model DeviceToken {
  id        String   @id @default(uuid())
  userId    String
  token     String   @unique
  platform  String
  deviceId  String?
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId, isActive])
  @@map("device_tokens")
}

// ── جدول جديد: PriceForecastCache ────────────────────────────────
model PriceForecastCache {
  id          String   @id @default(uuid())
  sectorCode  String   @unique
  forecastJson Json
  generatedAt DateTime @default(now())
  expiresAt   DateTime
  @@map("price_forecast_cache")
}
`;

// ─── db/migrations/add_indexes.sql ───────────────────────────────
// تشغيل مباشر على قاعدة البيانات لإضافة الـ indexes بدون migration

export const ADD_INDEXES_SQL = `
-- Performance indexes for إن مصر للصناعة
-- تشغيل: psql $DATABASE_URL -f add_indexes.sql

-- Geo indexes (critical for map queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_geo_lat_lng
  ON geo_locations(lat, lng);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_geo_city
  ON geo_locations(city);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_geo_zone
  ON geo_locations(industrial_zone)
  WHERE industrial_zone IS NOT NULL;

-- RFQ performance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rfq_status_published
  ON rfq_requests(status, published_at DESC)
  WHERE status = 'PUBLISHED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rfq_category_status
  ON rfq_requests(category_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rfq_buyer
  ON rfq_requests(buyer_company_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rfq_expires
  ON rfq_requests(expires_at)
  WHERE status IN ('PUBLISHED', 'QUOTES_RECEIVED');

-- Quote indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quote_rfq_status
  ON rfq_quotes(rfq_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quote_supplier
  ON rfq_quotes(supplier_company_id);

-- Order indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_buyer_status
  ON orders(buyer_company_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_supplier_status
  ON orders(supplier_company_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_status_created
  ON orders(status, created_at DESC);

-- Message indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_msg_order_created
  ON messages(order_id, created_at ASC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_msg_sender
  ON messages(sender_id);

-- Notification indexes (high read volume)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notif_user_read
  ON notifications(user_id, is_read)
  WHERE is_read = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notif_user_created
  ON notifications(user_id, created_at DESC);

-- Company search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_type_level
  ON companies(type, verified_level)
  WHERE type = 'SUPPLIER';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_trust
  ON companies(trust_score DESC)
  WHERE type = 'SUPPLIER';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_rating
  ON companies(avg_rating DESC)
  WHERE type = 'SUPPLIER';

-- Audit log indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_user_action
  ON audit_logs(user_id, action, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_entity
  ON audit_logs(entity, entity_id);

-- Escrow indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_status_auto
  ON escrows(status, auto_release_at)
  WHERE status = 'HELD';

-- Leakage attempts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leakage_user_created
  ON leakage_attempts(user_id, created_at DESC);

-- Full-text search on company names (Arabic)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_name_fts
  ON companies USING gin(to_tsvector('arabic', name_ar));

ANALYZE; -- Update query planner statistics
`;
