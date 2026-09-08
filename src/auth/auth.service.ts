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

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private notifications: NotificationsService,
  ) {}

  // ── REGISTER ──────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    // Check duplicates
    const exists = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.email ? { email: dto.email } : {},
          dto.phone ? { phoneHash: await this.hashPhone(dto.phone) } : {},
        ],
      },
    });
    if (exists) throw new ConflictException('البريد الإلكتروني أو رقم الهاتف مسجل مسبقاً');

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 12)
      : null;

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phoneHash: dto.phone ? await this.hashPhone(dto.phone) : null,
        phoneRelay: dto.phone ? `relay-${uuidv4().slice(0, 8)}@inmisr.net` : null,
        passwordHash,
        role: dto.role,
        company: {
          create: {
            nameAr: dto.companyNameAr,
            nameEn: dto.companyNameEn,
            type: dto.role,
            location: dto.city ? {
              create: {
                city: dto.city,
                governorate: dto.governorate || dto.city,
                industrialZone: dto.industrialZone,
                lat: 30.0444, lng: 31.2357, // Default Cairo
              }
            } : undefined,
            subscription: { create: { plan: 'FREE' } },
          }
        }
      },
      include: { company: true },
    });

    // Send OTP
    await this.sendOtp(user.id, 'EMAIL_VERIFY', dto.email, dto.phone);

    return { message: 'تم إنشاء الحساب — يرجى تأكيد بريدك الإلكتروني أو رقم هاتفك', userId: user.id };
  }

  // ── LOGIN ─────────────────────────────────────────────────────
  async login(dto: LoginDto, ip: string, ua: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.emailOrPhone.includes('@') ? { email: dto.emailOrPhone } : {},
          { phoneHash: await this.hashPhone(dto.emailOrPhone) },
        ],
      },
      include: { company: { include: { subscription: true } } },
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

  // ── OTP ───────────────────────────────────────────────────────
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

  // ── REFRESH TOKEN ─────────────────────────────────────────────
  async refreshTokens(refreshToken: string, ip: string, ua: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: { include: { company: { include: { subscription: true } } } } },
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
    const payload = {
      sub: user.id,
      role: user.role,
      companyId: user.company?.id,
      plan: user.company?.subscription?.plan || 'FREE',
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
    return safe;
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

  @ApiProperty({ example: 'حديد مصر للتجارة' })
  @IsString()
  companyNameAr: string;

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
