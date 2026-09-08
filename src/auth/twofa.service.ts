// ─── twofa/twofa.service.ts ───────────────────────────────────────
import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { EncryptionService } from '../common/encryption.service';
import * as crypto from 'crypto';
import * as qrcode from 'qrcode';
import { authenticator } from 'otplib';

@Injectable()
export class TwoFaService {
  constructor(
    private prisma:     PrismaService,
    private encryption: EncryptionService,
  ) {
    // TOTP settings: 6 digits, 30s window, 1 window tolerance
    authenticator.options = { digits: 6, step: 30, window: 1 };
  }

  // ── SETUP: Generate secret + QR code ─────────────────────────
  async setupTwoFa(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFaEnabled) throw new BadRequestException('المصادقة الثنائية مفعلة بالفعل');

    const secret = authenticator.generateSecret(32);
    const issuer = 'إن مصر للصناعة';
    const label  = encodeURIComponent(user.email || `user-${userId.slice(-6)}`);
    const otpauthUrl = authenticator.keyuri(label, issuer, secret);

    // Generate QR code as base64 PNG
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl, {
      width: 256, margin: 2,
      color: { dark: '#0D0D0D', light: '#FFFFFF' },
    });

    // Store encrypted secret (not yet active until verified)
    await this.prisma.user.update({
      where: { id: userId },
      data:  { twoFaSecret: this.encryption.encrypt(secret) },
    });

    return {
      secret,
      qrCodeDataUrl: qrDataUrl,
      otpauthUrl,
      backupCodesPreview: 'يُولَّد عند التفعيل',
      instructions: [
        'افتح تطبيق المصادقة (Google Authenticator أو Authy)',
        'امسح رمز QR أو أدخل الرمز السري يدوياً',
        'أدخل الكود المكوّن من ٦ أرقام لتأكيد الإعداد',
      ],
    };
  }

  // ── ACTIVATE: Verify first TOTP + generate backup codes ──────
  async activateTwoFa(userId: string, totpCode: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFaSecret) throw new BadRequestException('يجب إعداد المصادقة الثنائية أولاً');
    if (user.twoFaEnabled) throw new BadRequestException('المصادقة الثنائية مفعلة بالفعل');

    const secret = this.encryption.decrypt(user.twoFaSecret);
    const valid  = authenticator.verify({ token: totpCode, secret });
    if (!valid) throw new UnauthorizedException('كود التحقق غير صحيح');

    // Generate 10 single-use backup codes
    const backupCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{4}/g)!.join('-')
    );
    const hashedBackups = backupCodes.map(c => this.encryption.hash(c));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFaEnabled: true,
        twoFaSecret:  this.encryption.encrypt(secret),
      },
    });

    // Store hashed backup codes in audit log (for retrieval)
    await this.prisma.auditLog.create({
      data: {
        userId,
        action:   '2FA_ACTIVATED',
        entity:   'User',
        entityId: userId,
        newValue: { backupCodesHashed: hashedBackups, count: backupCodes.length },
      },
    });

    return {
      activated: true,
      backupCodes, // Show ONCE — user must save these
      warning: 'احفظ هذه الرموز الاحتياطية في مكان آمن. لن تُعرض مرة أخرى.',
    };
  }

  // ── VERIFY: Called during login ───────────────────────────────
  async verifyTwoFa(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFaEnabled || !user.twoFaSecret) return true; // 2FA not enabled

    const secret  = this.encryption.decrypt(user.twoFaSecret);
    const isTotp  = authenticator.verify({ token: code, secret });
    if (isTotp) return true;

    // Try backup codes
    const isBackup = await this.verifyBackupCode(userId, code);
    if (isBackup) return true;

    throw new UnauthorizedException('كود المصادقة غير صحيح أو منتهي الصلاحية');
  }

  // ── DISABLE 2FA ───────────────────────────────────────────────
  async disableTwoFa(userId: string, totpCode: string, password: string) {
    await this.verifyTwoFa(userId, totpCode);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: false, twoFaSecret: null },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: '2FA_DISABLED', entity: 'User', entityId: userId },
    });
    return { disabled: true };
  }

  // ── REGENERATE BACKUP CODES ───────────────────────────────────
  async regenerateBackupCodes(userId: string, totpCode: string) {
    await this.verifyTwoFa(userId, totpCode);
    const backupCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{4}/g)!.join('-')
    );
    const hashedBackups = backupCodes.map(c => this.encryption.hash(c));
    await this.prisma.auditLog.create({
      data: {
        userId, action: '2FA_BACKUP_REGEN', entity: 'User', entityId: userId,
        newValue: { backupCodesHashed: hashedBackups },
      },
    });
    return { backupCodes, warning: 'الرموز القديمة لم تعد صالحة' };
  }

  private async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const normalizedCode = code.toUpperCase().replace(/\s/g, '');
    const hashed = this.encryption.hash(normalizedCode);
    const log = await this.prisma.auditLog.findFirst({
      where: {
        userId,
        action:   { in: ['2FA_ACTIVATED', '2FA_BACKUP_REGEN'] },
        newValue: { path: ['backupCodesHashed'], array_contains: hashed },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!log) return false;
    // Mark code as used by removing from the list
    const codes = (log.newValue as any).backupCodesHashed.filter((c: string) => c !== hashed);
    await this.prisma.auditLog.update({
      where: { id: log.id },
      data: { newValue: { ...(log.newValue as any), backupCodesHashed: codes } },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: '2FA_BACKUP_USED', entity: 'User', entityId: userId },
    });
    return true;
  }
}
