// ─── encryption/encryption.service.ts ────────────────────────────
// AES-256-GCM encryption for all sensitive data at rest
// Compliant with قانون حماية البيانات الشخصية رقم ١٥١/٢٠٢٠

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGO      = 'aes-256-gcm';
const IV_LEN    = 16;  // 128-bit IV
const TAG_LEN   = 16;  // 128-bit auth tag
const KEY_LEN   = 32;  // 256-bit key

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly masterKey: Buffer;
  private readonly keyVersion: number = 1;

  constructor(private config: ConfigService) {
    const rawKey = config.get<string>('ENCRYPTION_MASTER_KEY');
    if (!rawKey || rawKey.length < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must be at least 32 characters');
    }
    // Derive a fixed 256-bit key using PBKDF2
    this.masterKey = crypto.pbkdf2Sync(
      rawKey,
      'inmisr-industry-salt-v1',
      100_000,
      KEY_LEN,
      'sha256',
    );
  }

  // ── ENCRYPT ───────────────────────────────────────────────────
  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const iv         = crypto.randomBytes(IV_LEN);
    const cipher     = crypto.createCipheriv(ALGO, this.masterKey, iv);
    const encrypted  = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag    = cipher.getAuthTag();

    // Format: v{version}:{iv_hex}:{tag_hex}:{ciphertext_hex}
    return `v${this.keyVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  // ── DECRYPT ───────────────────────────────────────────────────
  decrypt(ciphertext: string): string {
    if (!ciphertext) return ciphertext;

    const parts = ciphertext.split(':');
    if (parts.length !== 4 || !parts[0].startsWith('v')) {
      // Legacy unencrypted value — return as-is (migration period)
      this.logger.warn('Decrypting unencrypted legacy value');
      return ciphertext;
    }

    const iv        = Buffer.from(parts[1], 'hex');
    const authTag   = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');

    const decipher  = crypto.createDecipheriv(ALGO, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  // ── HASH (one-way, for lookups like phone search) ─────────────
  hash(value: string): string {
    return crypto
      .createHmac('sha256', this.masterKey)
      .update(value.toLowerCase().replace(/\D/g, ''))
      .digest('hex');
  }

  // ── ENCRYPT OBJECT FIELDS ─────────────────────────────────────
  encryptFields<T extends Record<string, any>>(
    obj: T,
    fields: (keyof T)[],
  ): T {
    const result = { ...obj };
    for (const field of fields) {
      if (result[field] && typeof result[field] === 'string') {
        (result as any)[field] = this.encrypt(result[field] as string);
      }
    }
    return result;
  }

  decryptFields<T extends Record<string, any>>(
    obj: T,
    fields: (keyof T)[],
  ): T {
    const result = { ...obj };
    for (const field of fields) {
      if (result[field] && typeof result[field] === 'string') {
        try {
          (result as any)[field] = this.decrypt(result[field] as string);
        } catch {
          // If decryption fails, leave as-is
        }
      }
    }
    return result;
  }

  // ── PII FIELD DEFINITIONS ─────────────────────────────────────
  // These fields are encrypted in DB, decrypted only when needed
  static readonly PII_FIELDS = {
    users:         ['email', 'phoneRelay'] as const,
    companies:     ['commercialRegNo', 'taxId'] as const,
    verifications: ['fileUrlEnc', 'ocrDataJson'] as const,
    messages:      ['contentEncrypted'] as const,
  };

  // ── KEY ROTATION ──────────────────────────────────────────────
  async rotateKey(oldKey: string, newKey: string, tableName: string, fieldName: string, prisma: any) {
    this.logger.log(`Starting key rotation for ${tableName}.${fieldName}`);
    const oldService = new EncryptionService({ get: () => oldKey } as any);
    const newService = new EncryptionService({ get: () => newKey } as any);

    let processed = 0;
    const batchSize = 100;
    let cursor: string | undefined;

    do {
      const records = await (prisma[tableName] as any).findMany({
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, [fieldName]: true },
      });

      for (const record of records) {
        if (!record[fieldName]) continue;
        const decrypted = oldService.decrypt(record[fieldName]);
        const reEncrypted = newService.encrypt(decrypted);
        await (prisma[tableName] as any).update({
          where: { id: record.id },
          data: { [fieldName]: reEncrypted },
        });
        processed++;
      }

      cursor = records.at(-1)?.id;
      if (records.length < batchSize) break;
    } while (true);

    this.logger.log(`Key rotation complete: ${processed} records updated`);
    return { processed };
  }
}
