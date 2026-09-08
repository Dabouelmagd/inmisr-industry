// ─── migration/encrypt-migration.ts ──────────────────────────────
// سكريبت تشفير البيانات الموجودة في قاعدة البيانات بعد إضافة AES-256
// تشغيل مرة واحدة فقط: npx ts-node migration/encrypt-migration.ts

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as readline from 'readline';

const prisma = new PrismaClient();

function deriveKey(masterKey: string): Buffer {
  return crypto.pbkdf2Sync(masterKey, 'inmisr-industry-salt-v1', 100_000, 32, 'sha256');
}

function encrypt(plaintext: string, key: Buffer): string {
  if (!plaintext) return plaintext;
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function isAlreadyEncrypted(value: string): boolean {
  return value?.startsWith('v1:') && value.split(':').length === 4;
}

async function migrateTable(
  tableName: string,
  findFn:    () => Promise<any[]>,
  updateFn:  (id: string, encrypted: Record<string, string>) => Promise<void>,
  fields:    string[],
  key:       Buffer,
) {
  const records = await findFn();
  let processed = 0, skipped = 0;

  for (const record of records) {
    const updates: Record<string, string> = {};
    let hasChanges = false;

    for (const field of fields) {
      const val = record[field];
      if (val && typeof val === 'string' && !isAlreadyEncrypted(val)) {
        updates[field] = encrypt(val, key);
        hasChanges = true;
      } else {
        skipped++;
      }
    }

    if (hasChanges) {
      await updateFn(record.id, updates);
      processed++;
    }
  }

  console.log(`  ✓ ${tableName}: ${processed} encrypted, ${skipped} already encrypted/null`);
  return { processed, skipped };
}

async function main() {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey || masterKey.length < 32) {
    console.error('❌ ENCRYPTION_MASTER_KEY must be set and at least 32 chars');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => {
    rl.question('\n⚠️  هذا السكريبت سيشفر البيانات الحساسة. تأكد من أخذ نسخة احتياطية أولاً. استمرار؟ (yes/no): ', (answer) => {
      rl.close();
      if (answer.toLowerCase() !== 'yes') { console.log('تم الإلغاء.'); process.exit(0); }
      resolve();
    });
  });

  const key = deriveKey(masterKey);
  console.log('\n🔐 بدء تشفير البيانات...\n');

  let total = { processed: 0, skipped: 0 };

  // Encrypt user emails
  const emailResult = await migrateTable(
    'users (email)',
    () => prisma.user.findMany({ select: { id: true, email: true }, where: { email: { not: null } } }),
    (id, data) => prisma.user.update({ where: { id }, data }).then(() => {}),
    ['email'],
    key,
  );
  total.processed += emailResult.processed;

  // Encrypt company sensitive fields
  const companyResult = await migrateTable(
    'companies (commercialRegNo, taxId)',
    () => prisma.company.findMany({ select: { id: true, commercialRegNo: true, taxId: true } }),
    (id, data) => prisma.company.update({ where: { id }, data }).then(() => {}),
    ['commercialRegNo', 'taxId'],
    key,
  );
  total.processed += companyResult.processed;

  // Encrypt verification file URLs
  const verifResult = await migrateTable(
    'verifications (fileUrlEnc)',
    () => prisma.verification.findMany({ select: { id: true, fileUrlEnc: true } }),
    (id, data) => prisma.verification.update({ where: { id }, data }).then(() => {}),
    ['fileUrlEnc'],
    key,
  );
  total.processed += verifResult.processed;

  console.log(`\n✅ اكتمل التشفير — ${total.processed} سجل مشفر`);
  console.log('ملاحظة: أعد تشغيل الـ API بعد اكتمال التشفير');
}

main()
  .catch(e => { console.error('❌ Migration failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

// ─── config/env-validator.ts ──────────────────────────────────────
// التحقق من متغيرات البيئة عند بدء التشغيل

export interface EnvConfig {
  NODE_ENV:              string;
  PORT:                  number;
  DATABASE_URL:          string;
  REDIS_URL:             string;
  JWT_ACCESS_SECRET:     string;
  JWT_REFRESH_SECRET:    string;
  ENCRYPTION_MASTER_KEY: string;
  PAYMOB_API_KEY:        string;
  PAYMOB_HMAC_SECRET:    string;
  TWILIO_ACCOUNT_SID:    string;
  TWILIO_AUTH_TOKEN:     string;
  SMTP_USER:             string;
  AWS_ACCESS_KEY_ID:     string;
  AWS_S3_BUCKET:         string;
}

export function validateEnvVars(): void {
  const required: Array<{ key: string; minLength?: number; description: string }> = [
    { key: 'DATABASE_URL',          description: 'PostgreSQL connection string' },
    { key: 'JWT_ACCESS_SECRET',     minLength: 32, description: 'JWT access token secret (min 32 chars)' },
    { key: 'JWT_REFRESH_SECRET',    minLength: 32, description: 'JWT refresh token secret (min 32 chars)' },
    { key: 'ENCRYPTION_MASTER_KEY', minLength: 32, description: 'AES-256 master encryption key (min 32 chars)' },
  ];

  const optional: string[] = [
    'REDIS_URL', 'RABBITMQ_URL', 'PAYMOB_API_KEY', 'PAYMOB_HMAC_SECRET',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_USER', 'SMTP_PASS',
    'FCM_SERVER_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET', 'GOOGLE_MAPS_KEY', 'ELASTIC_URL',
    'ETA_CLIENT_ID', 'ETA_CLIENT_SECRET', 'ETA_SUPPLIER_TIN',
  ];

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const { key, minLength, description } of required) {
    const val = process.env[key];
    if (!val) {
      errors.push(`  ✗ ${key} — ${description}`);
    } else if (minLength && val.length < minLength) {
      errors.push(`  ✗ ${key} — يجب أن يكون ${minLength} حرف على الأقل (حالياً: ${val.length})`);
    }
  }

  for (const key of optional) {
    if (!process.env[key]) {
      warnings.push(`  ⚠ ${key} — غير مضبوط (بعض الميزات لن تعمل)`);
    }
  }

  if (errors.length > 0) {
    console.error('\n❌ خطأ: متغيرات البيئة المطلوبة غير مضبوطة:\n');
    errors.forEach(e => console.error(e));
    console.error('\nالحل: نسخي .env.complete إلى .env وعبّئي القيم\n');
    if (process.env.NODE_ENV === 'production') process.exit(1);
    console.error('⚠️  التشغيل في وضع التطوير مع متغيرات ناقصة\n');
  }

  if (warnings.length > 0 && process.env.NODE_ENV !== 'test') {
    console.warn('\n⚠️  تحذيرات متغيرات البيئة:');
    warnings.forEach(w => console.warn(w));
    console.warn('');
  }
}

// ─── config/health.controller.ts ─────────────────────────────────
// Health check endpoint يفحص كل الخدمات

import {
  Controller, Get, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../guards/jwt.guard';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'فحص صحة الخدمة' })
  async check() {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkElastic(),
    ]);

    const [db, redis, elastic] = checks.map(r =>
      r.status === 'fulfilled' ? r.value : { status: 'DOWN', error: (r as any).reason?.message }
    );

    const allUp = [db, redis].every((c: any) => c.status === 'UP');

    return {
      status:    allUp ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version:   '2.0.0',
      service:   'إن مصر للصناعة API',
      uptime:    Math.floor(process.uptime()),
      memory: {
        used:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit:  'MB',
      },
      checks: { database: db, redis, elasticsearch: elastic },
    };
  }

  @Get('ping')
  @Public()
  @HttpCode(HttpStatus.OK)
  ping() { return { pong: true, ts: Date.now() }; }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Kubernetes readiness probe' })
  async ready() {
    const db = await this.checkDatabase();
    if ((db as any).status !== 'UP') {
      throw new Error('Database not ready');
    }
    return { ready: true };
  }

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Kubernetes liveness probe' })
  live() { return { alive: true }; }

  private async checkDatabase() {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const p = new PrismaClient();
      await p.$queryRaw`SELECT 1`;
      await p.$disconnect();
      return { status: 'UP', responseMs: 0 };
    } catch (e: any) {
      return { status: 'DOWN', error: e.message };
    }
  }

  private async checkRedis() {
    try {
      const redis = await import('ioredis');
      const client = new redis.default(process.env.REDIS_URL || 'redis://localhost:6379');
      const start = Date.now();
      await client.ping();
      const ms = Date.now() - start;
      await client.quit();
      return { status: 'UP', responseMs: ms };
    } catch (e: any) {
      return { status: 'DOWN', error: e.message };
    }
  }

  private async checkElastic() {
    try {
      const axios = await import('axios');
      const start = Date.now();
      await axios.default.get(`${process.env.ELASTIC_URL || 'http://localhost:9200'}/_cluster/health`, { timeout: 3000 });
      return { status: 'UP', responseMs: Date.now() - start };
    } catch (e: any) {
      return { status: 'DEGRADED', error: 'Elasticsearch unavailable (search falls back to DB)' };
    }
  }
}
