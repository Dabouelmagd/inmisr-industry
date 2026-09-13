// ─── app/app.module.ts ─────────────────────────────────────────────
// الـ Module النهائي الذي يجمع كل خدمات المنصة
// كل مسارات الاستيراد هنا مُتحقَّق منها فعلياً مقابل بنية الملفات الحقيقية

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';

// ── Core Services ────────────────────────────────────────────────
import { PrismaService }          from '../common/prisma.service';
import { AuthService }            from '../auth/auth.service';
import { SuppliersService }       from '../suppliers/suppliers.service';
import { RfqService }             from '../rfq/rfq.service';
import { EscrowService }          from '../escrow/escrow.service';
import { NotificationsService }   from '../notifications/notifications.service';
import { AntiLeakageService }     from '../common/anti-leakage.service';
import {
  GeoService, FinanceService, InspectionService, TrainingService, FactoryNeedService, ReverseLogisticsService, JobPostingService, SmeProjectService, PromoCodeService, TradeApplicationService, SpecialOfferService, SolarLeadService, ServiceConsultationService, ProviderListingService, CompanyAssistantService, CompanyProfileService, IncubatorService, OrdersService, MessagesService,
} from '../common/remaining-services';

// ── Infrastructure Services ────────────────────────────────────────
import { EncryptionService }      from '../common/encryption.service';
import { UploadService, UploadController } from '../common/upload.service';
import { CronService }            from '../common/cron.service';
import { InMisrWebSocketGateway } from '../common/websocket.gateway';
import { QueueService }           from '../common/queue.service';
import { SearchService }          from '../search/search.service';

// ── Auth Extras ───────────────────────────────────────────────────
import { TwoFaService }           from '../auth/twofa.service';
import {
  PasswordResetService, PasswordResetController,
} from '../auth/password-reset.service';

// ── Business Services ────────────────────────────────────────────
import { InvoiceService }         from '../finance/invoice.service';
import { PaymentService, PaymentController } from '../finance/payment.service';
import { LoyaltyService }         from '../loyalty/loyalty.service';
import { AdminService }           from '../admin/admin.service';
import { ReportsService }         from '../admin/reports.service';
import { OcrService }             from '../common/ocr.service';
import { MapsService }            from '../geo/maps.service';
import {
  ProductsService, ProductsController,
  ReviewsService, ReviewsController,
  CategoriesService, CategoriesController,
  SubscriptionsService, SubscriptionsController,
} from '../products/products.service';
import { AdsService, AdsController } from '../ads/ads.service';
import { AdsV2Service, AdsV2Controller } from '../ads-v2/ads-v2.service';
import { PriceForecastService, PriceForecastController } from '../ai/price-forecast.service';
import {
  SupplierDashboardService, BuyerDashboardService, DashboardController,
} from '../suppliers/supplier-dashboard.service';

// ── Controllers ───────────────────────────────────────────────────
import {
  HealthController, AuthController, SuppliersController,
  RfqController, OrdersController, EscrowController,
  MessagesController, GeoController, FinanceController, InspectionController, TrainingController, FactoryNeedController, ReverseLogisticsController, JobPostingController, SmeProjectController, PromoCodeController, TradeApplicationController, SpecialOfferController, SolarLeadController, ServiceConsultationController, ProviderListingController, CompanyAssistantController, CompanyProfileController,
  IncubatorController, NotificationsController, AntiLeakageController,
} from './controllers';
import {
  AdminController, LoyaltyController,
  TwoFaController, InvoicesController,
} from '../admin/admin.controller';
import {
  SearchController, MapsController,
} from '../search/search.controller';

// ── Webhook Controllers ───────────────────────────────────────────
import { PaymobWebhookController, FawryWebhookController } from '../escrow/paymob.webhook';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    JwtModule.registerAsync({
      global: true,
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1000,  limit: 5   },
      { name: 'medium', ttl: 10000, limit: 20  },
      { name: 'long',   ttl: 60000, limit: 100 },
    ]),
    ScheduleModule.forRoot(),
    CacheModule.register({ isGlobal: true, ttl: 300 }),
  ],

  controllers: [
    // Core
    HealthController, AuthController, SuppliersController,
    RfqController, OrdersController, EscrowController,
    MessagesController, GeoController, FinanceController, InspectionController, TrainingController, FactoryNeedController, ReverseLogisticsController, JobPostingController, SmeProjectController, PromoCodeController, TradeApplicationController, SpecialOfferController, SolarLeadController, ServiceConsultationController, ProviderListingController, CompanyAssistantController, CompanyProfileController,
    IncubatorController, NotificationsController, AntiLeakageController,
    // Auth extras
    PasswordResetController,
    // Products / Reviews / Categories / Subscriptions
    ProductsController, ReviewsController, CategoriesController, SubscriptionsController,
    // Ads / AI / Dashboard / Search / Maps / Payment
    AdsController, AdsV2Controller, PriceForecastController, DashboardController,
    SearchController, MapsController, PaymentController,
    // Upload
    UploadController,
    // Admin & extras
    AdminController, LoyaltyController, TwoFaController, InvoicesController,
    // Webhooks
    PaymobWebhookController, FawryWebhookController,
  ],

  providers: [
    // Core
    PrismaService, AuthService, SuppliersService, RfqService,
    EscrowService, NotificationsService, AntiLeakageService,
    GeoService, FinanceService, InspectionService, TrainingService, FactoryNeedService, ReverseLogisticsService, JobPostingService, SmeProjectService, PromoCodeService, TradeApplicationService, SpecialOfferService, SolarLeadService, ServiceConsultationService, ProviderListingService, CompanyAssistantService, CompanyProfileService, IncubatorService, OrdersService, MessagesService,
    // Infrastructure
    EncryptionService, UploadService, CronService,
    InMisrWebSocketGateway, QueueService, SearchService,
    // Auth extras
    TwoFaService, PasswordResetService,
    // Business
    InvoiceService, PaymentService, LoyaltyService,
    AdminService, ReportsService, OcrService, MapsService,
    ProductsService, ReviewsService, CategoriesService, SubscriptionsService,
    AdsService, AdsV2Service, PriceForecastService,
    SupplierDashboardService, BuyerDashboardService,
  ],
})
export class AppModule {}

// ─── ENVIRONMENT VARIABLES REQUIRED ──────────────────────────────
export const REQUIRED_ENV_VARS = [
  // Security
  'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_MASTER_KEY',
  // Database
  'DATABASE_URL',
  // Cache & Queue
  'REDIS_URL', 'RABBITMQ_URL',
  // Payments
  'PAYMOB_API_KEY', 'PAYMOB_HMAC_SECRET', 'PAYMOB_INTEGRATION_ID',
  'FAWRY_MERCHANT_CODE', 'FAWRY_SECURITY_KEY',
  // Communications
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_EMAIL',
  'FCM_SERVER_KEY',
  // Storage
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET', 'AWS_REGION',
  // Maps
  'GOOGLE_MAPS_KEY',
  // Search
  'ELASTIC_URL',
  // Tax Authority
  'ETA_CLIENT_ID', 'ETA_CLIENT_SECRET', 'ETA_SUPPLIER_TIN', 'ETA_SIGNING_KEY',
] as const;

export function validateEnv(config: ConfigService) {
  const missing = REQUIRED_ENV_VARS.filter(v => !config.get(v));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables:\n${missing.map(v => `  - ${v}`).join('\n')}`);
  }
}
