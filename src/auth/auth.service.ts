// ─── auth/auth.service.ts ─────────────────────────────────────────
import {
  Injectable, UnauthorizedException, ConflictException,
  BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';

// Real (public, well-known) approximate coordinates for Egypt's major
// industrial zones and governorate capitals — used to place a newly
// registered company somewhere close to its real stated location,
// instead of every single company landing on the exact same point
// (which is what a hardcoded 30.0444/31.2357 default used to do,
// silently breaking geo-radius supplier search for every real user).
const EGYPT_ZONE_COORDS: Record<string, { lat: number; lng: number }> = {
  'العاشر من رمضان': { lat: 30.294, lng: 31.743 },
  '6 أكتوبر': { lat: 29.970, lng: 30.930 },
  'مدينة العبور': { lat: 30.249, lng: 31.818 },
  'العبور': { lat: 30.249, lng: 31.818 },
  'مدينة السادات': { lat: 30.369, lng: 30.528 },
  'السادات': { lat: 30.369, lng: 30.528 },
  'برج العرب': { lat: 30.898, lng: 29.547 },
  'برج العرب الجديدة': { lat: 30.8667, lng: 29.6167 },
  'إمبابة': { lat: 30.067, lng: 31.205 },
  'مدينة بدر': { lat: 30.121, lng: 31.745 },
  'بدر': { lat: 30.121, lng: 31.745 },
  'مدينة الشروق': { lat: 30.157, lng: 31.614 },
  'الشروق': { lat: 30.157, lng: 31.614 },
  'المحلة الكبرى': { lat: 30.973, lng: 31.167 },
  'المحلة': { lat: 30.973, lng: 31.167 },
  'الروبيكي': { lat: 29.900, lng: 31.350 },
  'العين السخنة': { lat: 29.600, lng: 32.317 },
  'دمياط': { lat: 31.4165, lng: 31.8133 },
  'العاصمة الإدارية الجديدة': { lat: 30.0200, lng: 31.7000 },
  'القاهرة': { lat: 30.0444, lng: 31.2357 },
  'الجيزة': { lat: 30.0131, lng: 31.2089 },
  'الإسكندرية': { lat: 31.2001, lng: 29.9187 },
  'السويس': { lat: 29.9668, lng: 32.5498 },
  'بورسعيد': { lat: 31.2565, lng: 32.2841 },
  'الإسماعيلية': { lat: 30.6043, lng: 32.2723 },
};

function resolveZoneCoords(industrialZone?: string, city?: string, governorate?: string): { lat: number; lng: number } {
  const key = industrialZone || city || governorate;
  if (key && EGYPT_ZONE_COORDS[key]) return EGYPT_ZONE_COORDS[key];
  // Small deterministic jitter (±~5km) so unmatched locations don't all
  // stack on the exact same pin either.
  const seed = (key || 'default').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const jitter = ((seed % 100) / 100 - 0.5) * 0.08;
  return { lat: 30.0444 + jitter, lng: 31.2357 + jitter };
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private notifications: NotificationsService,
  ) {}

  // Roles that must never be self-service-registerable through the
  // public form — only creatable via the one-time bootstrap secret
  // (SUPER_ADMIN) or by an authenticated SUPER_ADMIN via /auth/team (ADMIN).
  private static PRIVILEGED_ROLES = ['ADMIN', 'SUPER_ADMIN'];

  // ── REGISTER ──────────────────────────────────────────────────
  async register(dto: RegisterDto, adminBootstrapSecret?: string) {
    const isWorker = dto.role === 'WORKER';

    if (AuthService.PRIVILEGED_ROLES.includes(dto.role)) {
      const expected = this.config.get<string>('ADMIN_BOOTSTRAP_SECRET');
      if (!expected || adminBootstrapSecret !== expected) {
        throw new ForbiddenException('غير مصرح بإنشاء حساب بهذه الصلاحية عبر التسجيل العام');
      }
    } else if (isWorker) {
      if (!dto.fullName?.trim()) throw new BadRequestException('الاسم بالكامل مطلوب');
      if (!dto.phone?.trim()) throw new BadRequestException('رقم الهاتف مطلوب');
    } else if (!dto.companyNameAr) {
      throw new BadRequestException('اسم الشركة مطلوب');
    }

    // Check duplicates
    const exists = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.email ? { email: { equals: dto.email, mode: 'insensitive' } } : {},
          dto.phone ? { phoneHash: await this.hashPhone(dto.phone) } : {},
        ],
      },
    });
    if (exists) throw new ConflictException('البريد الإلكتروني أو رقم الهاتف مسجل مسبقاً');

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 12)
      : null;

    const isStaff = AuthService.PRIVILEGED_ROLES.includes(dto.role);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phoneHash: dto.phone ? await this.hashPhone(dto.phone) : null,
        phoneRelay: dto.phone ? `relay-${uuidv4().slice(0, 8)}@inmisr.net` : null,
        passwordHash,
        role: dto.role,
        company: (isStaff || isWorker) ? undefined : {
          create: {
            nameAr: dto.companyNameAr,
            nameEn: dto.companyNameEn,
            type: dto.role,
            location: dto.city ? {
              create: {
                city: dto.city,
                governorate: dto.governorate || dto.city,
                industrialZone: dto.industrialZone,
                ...(dto.lat != null && dto.lng != null
                  ? { lat: Number(dto.lat), lng: Number(dto.lng) }
                  : resolveZoneCoords(dto.industrialZone, dto.city, dto.governorate)),
              }
            } : undefined,
            subscription: { create: { plan: 'FREE' } },
          }
        },
        workerProfile: isWorker ? {
          create: {
            fullName: dto.fullName,
            phone: dto.phone,
            governorate: dto.governorate,
            interestedTrade: dto.interestedTrade,
          }
        } : undefined,
      },
      include: { company: true, workerProfile: true },
    });

    // Send OTP
    await this.sendOtp(user.id, 'EMAIL_VERIFY', dto.email, dto.phone);

    return { message: 'تم إنشاء الحساب — يرجى تأكيد بريدك الإلكتروني أو رقم هاتفك', userId: user.id };
  }

  // ── TEAM / ASSISTANTS (owner-managed) ───────────────────────────
  // Only ever called from an endpoint gated to req.user.role === 'SUPER_ADMIN'.
  async listTeamMembers() {
    return this.prisma.user.findMany({
      where: { role: { in: AuthService.PRIVILEGED_ROLES as any } },
      select: {
        id: true, email: true, role: true, isActive: true, isBanned: true,
        createdAt: true, lastLoginAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── CHANGE PASSWORD (authenticated user, for their own account) ──
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('المستخدم غير موجود');

    if (user.passwordHash) {
      const valid = currentPassword && await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) throw new UnauthorizedException('كلمة المرور الحالية غير صحيحة');
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
    await this.prisma.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
    return { message: 'تم تغيير كلمة المرور بنجاح — يرجى تسجيل الدخول مرة أخرى' };
  }

  async createTeamMember(dto: { email: string; password: string }) {
    const exists = await this.prisma.user.findFirst({ where: { email: { equals: dto.email, mode: 'insensitive' } } });
    if (exists) throw new ConflictException('البريد الإلكتروني مسجل مسبقاً');
    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        role: 'ADMIN' as any,
        emailVerified: true,
        kycStatus: 'VERIFIED' as any,
      },
    });

    await this.notifications.sendEmail(
      dto.email,
      'تمت إضافتك كمساعد إداري — إن مصر للصناعة',
      `تم إنشاء حساب مساعد إداري لك على منصة إن مصر للصناعة.\nالإيميل: ${dto.email}\nيرجى تسجيل الدخول وتغيير كلمة المرور من الإعدادات.`,
    );

    return { message: 'تم إضافة المساعد بنجاح', userId: user.id };
  }

  async removeTeamMember(userId: string, requesterId: string) {
    if (userId === requesterId) throw new BadRequestException('لا يمكنك إزالة حسابك الخاص');
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new BadRequestException('المستخدم غير موجود');
    if (target.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('لا يمكن إزالة حساب المالك (Super Admin)');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: false, isBanned: true, banReason: 'أُزيل من فريق الإدارة' },
    });
    return { message: 'تم إلغاء تفعيل حساب المساعد' };
  }

  // ── LOGIN ─────────────────────────────────────────────────────
  async login(dto: LoginDto, ip: string, ua: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.emailOrPhone.includes('@')
            ? { email: { equals: dto.emailOrPhone, mode: 'insensitive' } }
            : {},
          { phoneHash: await this.hashPhone(dto.emailOrPhone) },
        ],
      },
      include: { company: { include: { subscription: true } }, workerProfile: true, assistantOf: true },
    });

    if (!user) throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    if (user.isBanned) throw new ForbiddenException(`الحساب موقوف: ${user.banReason}`);

    if (dto.password && user.passwordHash) {
      const valid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!valid) throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip },
    });

    const tokens = await this.generateTokens(user, ip, ua);
    await this.notifications.send(user.id, 'SYSTEM', 'تسجيل دخول جديد', `تسجيل دخول من ${ip}`);

    return { ...tokens, user: this.sanitizeUser(user) };
  }

  getGoogleClientId(): string | null {
    return this.config.get<string>('GOOGLE_CLIENT_ID') || null;
  }

  // ── GOOGLE SIGN-IN — verifies the real ID token Google Identity
  // Services gives the browser; we never trust a client-supplied email.
  async googleLogin(idToken: string, ip: string, ua: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new BadRequestException('تسجيل الدخول بجوجل غير مُفعّل على الخادم بعد');
    }
    const client = new OAuth2Client(clientId);
    let payload: any;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      throw new UnauthorizedException('تعذر التحقق من حساب جوجل — حاولي مرة أخرى');
    }
    if (!payload || !payload.email || !payload.email_verified) {
      throw new UnauthorizedException('حساب جوجل هذا غير موثّق البريد الإلكتروني');
    }

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: payload.email, mode: 'insensitive' } },
      include: { company: { include: { subscription: true } }, workerProfile: true, assistantOf: true },
    });

    if (!user) {
      // Real accounts here need a role + company/worker info we don't have
      // from Google alone — hand back the verified email so the frontend
      // can pre-fill registration instead of fabricating an account.
      return { needsRegistration: true, email: payload.email, fullName: payload.name };
    }

    if (user.isBanned) throw new ForbiddenException(`الحساب موقوف: ${user.banReason}`);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip, emailVerified: true },
    });

    const tokens = await this.generateTokens(user, ip, ua);
    await this.notifications.send(user.id, 'SYSTEM', 'تسجيل دخول جديد', `تسجيل دخول بحساب جوجل من ${ip}`);

    return { ...tokens, user: this.sanitizeUser(user) };
  }
  async sendOtp(userId: string, purpose: string, email?: string, phone?: string) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await this.prisma.otpCode.create({
      data: { userId, code: await bcrypt.hash(code, 8), purpose, expiresAt },
    });

    // Send via SMS (Twilio) or Email (Nodemailer)
    if (phone) {
      await this.notifications.sendSms(phone, `كود التحقق إن مصر للصناعة: ${code}`);
    }
    if (email) {
      await this.notifications.sendEmail(email, 'كود التحقق — إن مصر للصناعة', `كودك: ${code} — صالح ١٠ دقائق`);
    }

    return { message: 'تم إرسال كود التحقق' };
  }

  async verifyOtp(userId: string, code: string, purpose: string) {
    const otps = await this.prisma.otpCode.findMany({
      where: { userId, purpose, isUsed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    if (!otps.length) throw new BadRequestException('الكود منتهي الصلاحية — يرجى طلب كود جديد');

    const otp = otps[0];
    if (otp.attempts >= 3) throw new BadRequestException('تم تجاوز عدد المحاولات المسموح بها');

    const valid = await bcrypt.compare(code, otp.code);
    if (!valid) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException(`كود غير صحيح — المحاولات المتبقية: ${2 - otp.attempts}`);
    }

    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { isUsed: true } });
    if (purpose === 'EMAIL_VERIFY') {
      await this.prisma.user.update({ where: { id: userId }, data: { emailVerified: true, kycStatus: 'UNDER_REVIEW' } });
    }

    return { message: 'تم التحقق بنجاح' };
  }

  // ── FORGOT / RESET PASSWORD ─────────────────────────────────────
  async forgotPassword(emailOrPhone: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          emailOrPhone.includes('@') ? { email: { equals: emailOrPhone, mode: 'insensitive' } } : {},
          { phoneHash: await this.hashPhone(emailOrPhone) },
        ],
      },
    });
    // Always return the same message regardless of whether the account
    // exists, so this endpoint can't be used to enumerate registered emails.
    if (user) {
      await this.sendOtp(user.id, 'PASSWORD_RESET', user.email, undefined);
    }
    return { message: 'إذا كان هذا البريد/الرقم مسجلاً لدينا، سيصلك كود لإعادة تعيين كلمة المرور' };
  }

  async resetPasswordWithOtp(emailOrPhone: string, code: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    }
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          emailOrPhone.includes('@') ? { email: { equals: emailOrPhone, mode: 'insensitive' } } : {},
          { phoneHash: await this.hashPhone(emailOrPhone) },
        ],
      },
    });
    if (!user) throw new BadRequestException('كود غير صحيح أو منتهي الصلاحية');

    await this.verifyOtp(user.id, code, 'PASSWORD_RESET'); // throws if invalid/expired/used
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { message: 'تم تغيير كلمة المرور بنجاح — يمكنك تسجيل الدخول الآن' };
  }

  // ── REFRESH TOKEN ─────────────────────────────────────────────
  async refreshTokens(refreshToken: string, ip: string, ua: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: { include: { company: { include: { subscription: true } }, workerProfile: true, assistantOf: true } } },
    });

    if (!stored || stored.isRevoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('جلسة منتهية — يرجى تسجيل الدخول مرة أخرى');
    }

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { isRevoked: true } });
    return this.generateTokens(stored.user, ip, ua);
  }

  // ── LOGOUT ────────────────────────────────────────────────────
  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });
    return { message: 'تم تسجيل الخروج بنجاح' };
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private async generateTokens(user: any, ip: string, ua: string) {
    const isActiveAssistant = user.assistantOf?.status === 'ACTIVE';
    const payload = {
      sub: user.id,
      role: user.role,
      companyId: user.company?.id || (isActiveAssistant ? user.assistantOf.companyId : undefined),
      workerId: user.workerProfile?.id,
      plan: user.company?.subscription?.plan || 'FREE',
      isAssistant: isActiveAssistant,
      assistantPermissions: isActiveAssistant ? user.assistantOf.permissions : undefined,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: '15m',
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ipAddress: ip,
        userAgent: ua,
      },
    });

    return { accessToken, refreshToken };
  }

  private async hashPhone(phone: string): Promise<string> {
    const normalized = phone.replace(/\D/g, '');
    return bcrypt.hash(normalized, 10);
  }

  private sanitizeUser(user: any) {
    const { passwordHash, twoFaSecret, phoneHash, ...safe } = user;
    const isActiveAssistant = user.assistantOf?.status === 'ACTIVE';
    return {
      ...safe,
      companyId: user.company?.id || (isActiveAssistant ? user.assistantOf.companyId : undefined),
      workerId: user.workerProfile?.id,
      isAssistant: isActiveAssistant,
      assistantPermissions: isActiveAssistant ? user.assistantOf.permissions : undefined,
      assistantRoleLabel: isActiveAssistant ? user.assistantOf.roleLabel : undefined,
    };
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────
import { IsString, IsEmail, IsOptional, IsEnum, MinLength, IsPhoneNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({ example: 'info@hadidmisr.com' })
  @IsEmail() @IsOptional()
  email?: string;

  @ApiProperty({ example: '01012345678' })
  @IsString() @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'password123', minLength: 8 })
  @IsString() @MinLength(8) @IsOptional()
  password?: string;

  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role: Role;

  @ApiProperty({ example: 'حديد مصر للتجارة', required: false })
  @IsString() @IsOptional()
  companyNameAr?: string;

  @ApiProperty({ example: 'Hadid Misr Trading', required: false })
  @IsString() @IsOptional()
  companyNameEn?: string;

  @ApiProperty({ example: 'العاشر من رمضان', required: false })
  @IsString() @IsOptional()
  city?: string;

  @ApiProperty({ required: false })
  @IsString() @IsOptional()
  governorate?: string;

  @ApiProperty({ required: false })
  @IsString() @IsOptional()
  industrialZone?: string;

  @ApiProperty({ example: 'أحمد كريم', required: false, description: 'مطلوب لتسجيل عامل/باحث عن عمل (role=WORKER)' })
  @IsString() @IsOptional()
  fullName?: string;

  @ApiProperty({ example: 'اللحام الصناعي', required: false })
  @IsString() @IsOptional()
  interestedTrade?: string;

  @ApiProperty({ required: false, description: 'إحداثيات حقيقية من متصفح المستخدم (بموافقته) — تُستخدم بدل تخمين الموقع من اسم المنطقة إن وُجدت' })
  @IsOptional()
  lat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  lng?: number;
}

export class LoginDto {
  @ApiProperty({ example: 'info@hadidmisr.com' })
  @IsString()
  emailOrPhone: string;

  @ApiProperty({ required: false })
  @IsString() @IsOptional()
  password?: string;
}

export class VerifyOtpDto {
  @ApiProperty()
  @IsString()
  userId: string;

  @ApiProperty()
  @IsString()
  code: string;

  @ApiProperty()
  @IsString()
  purpose: string;
}
