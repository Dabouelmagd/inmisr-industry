// ─── main.ts (Complete production-ready) ─────────────────────────
import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { GlobalExceptionFilter } from './common/exception.filter';
import { ResponseInterceptor, LoggingInterceptor, TimeoutInterceptor, CacheControlInterceptor } from './common/interceptors';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // Required for Paymob HMAC verification
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const config  = app.get(ConfigService);
  const port    = config.get<number>('PORT', 3001);
  const isProd  = config.get('NODE_ENV') === 'production';

  // ── Security Middleware ────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", 'data:', '*.amazonaws.com', '*.cloudfront.net'],
        connectSrc: ["'self'", 'wss:'],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));
  app.use(compression());
  app.use(cookieParser());

  // ── CORS ──────────────────────────────────────────────────────
  const origins = config.get<string>('CORS_ORIGINS', 'http://localhost:3000').split(',');
  app.enableCors({
    origin:      (origin, cb) => {
      if (!origin || origins.includes(origin) || !isProd) cb(null, true);
      else cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'hmac', 'Accept-Language'],
  });

  // ── Global Prefix ─────────────────────────────────────────────
  app.setGlobalPrefix('api/v1');

  // ── Global Pipes ──────────────────────────────────────────────
  app.useGlobalPipes(new ValidationPipe({
    whitelist:             true,
    forbidNonWhitelisted:  true,
    transform:             true,
    transformOptions:      { enableImplicitConversion: true },
    stopAtFirstError:      false,
  }));

  // ── Global Exception Filter ───────────────────────────────────
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Global Interceptors ───────────────────────────────────────
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TimeoutInterceptor(30000),
    new CacheControlInterceptor(),
    new ResponseInterceptor(),
  );

  // ── WebSocket (Socket.io) ─────────────────────────────────────
  app.useWebSocketAdapter(new (require('@nestjs/platform-socket.io').IoAdapter)(app));

  // ── Swagger Docs (non-production) ─────────────────────────────
  if (!isProd) {
    const swaggerCfg = new DocumentBuilder()
      .setTitle('إن مصر للصناعة API')
      .setDescription('In Misr Industry — B2B Industrial Marketplace — Complete API Documentation')
      .setVersion('2.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth',          'المصادقة والتسجيل')
      .addTag('suppliers',     'الموردون')
      .addTag('products',      'المنتجات')
      .addTag('rfq',           'طلبات عروض الأسعار')
      .addTag('orders',        'الطلبات')
      .addTag('escrow',        'نظام الدفع الضامن')
      .addTag('messages',      'المحادثات الآمنة')
      .addTag('reviews',       'التقييمات')
      .addTag('categories',    'القطاعات الصناعية')
      .addTag('subscriptions', 'الاشتراكات')
      .addTag('search',        'البحث المتقدم')
      .addTag('maps',          'الخريطة الجغرافية')
      .addTag('geo',           'البيانات الجغرافية')
      .addTag('finance',       'التمويل الصناعي')
      .addTag('incubator',     'الحاضنة الصناعية')
      .addTag('upload',        'رفع الملفات')
      .addTag('notifications', 'الإشعارات')
      .addTag('loyalty',       'نقاط الولاء')
      .addTag('invoices',      'الفواتير الإلكترونية')
      .addTag('2fa',           'المصادقة الثنائية')
      .addTag('admin',         'لوحة الإدارة')
      .addTag('anti-leakage',  'محرك منع التسريب')
      .addTag('health',        'فحص الصحة')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerCfg);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'إن مصر للصناعة — API Docs',
    });
    Logger.log(`📖 Swagger Docs: http://localhost:${port}/docs`);
  }

  // ── Graceful Shutdown ─────────────────────────────────────────
  app.enableShutdownHooks();
  process.on('SIGTERM', async () => {
    Logger.log('SIGTERM received — shutting down gracefully...');
    await app.close();
    process.exit(0);
  });

  await app.listen(port, '0.0.0.0');
  Logger.log(`🚀 InMisr Industry API: http://0.0.0.0:${port}/api/v1`);
  Logger.log(`🌍 Environment: ${config.get('NODE_ENV', 'development')}`);
}

bootstrap().catch(err => {
  Logger.error('Failed to start application', err);
  process.exit(1);
});
