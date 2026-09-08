// ─── auth/password-reset.service.ts ──────────────────────────────
import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService }        from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EncryptionService }    from '../common/encryption.service';
import * as bcrypt              from 'bcryptjs';
import * as crypto              from 'crypto';
import {
  Controller, Post, Body, Param, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEmail, MinLength, Matches } from 'class-validator';
import { ApiProperty }          from '@nestjs/swagger';

// ── DTOs ──────────────────────────────────────────────────────────
export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@company.com' })
  @IsEmail({}, { message: 'يرجى إدخال بريد إلكتروني صحيح' })
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() token: string;
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'كلمة المرور يجب أن تكون ٨ أحرف على الأقل' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)/, { message: 'يجب أن تحتوي على حروف وأرقام' })
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword: string;
  @ApiProperty({ minLength: 8 })
  @IsString() @MinLength(8) newPassword: string;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
    private encryption:    EncryptionService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // ── FORGOT PASSWORD ───────────────────────────────────────────
  async forgotPassword(email: string, ip?: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration attacks
    if (!user) {
      this.logger.log(`Password reset requested for unknown email: ${email.slice(0, 3)}***`);
      return { message: 'إذا كان البريد مسجلاً ستصلك رسالة خلال دقيقتين' };
    }

    // Invalidate existing unused tokens for this user
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, isUsed: false },
      data:  { isUsed: true },
    });

    // Generate secure token — store only the hash, email the raw token
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await this.prisma.passwordResetToken.create({
      data: { tokenHash, userId: user.id, expiresAt, ipAddress: ip },
    });

    const resetUrl = `https://inmisr.net/reset-password?token=${token}`;

    await this.notifications.sendEmail(
      email,
      'إعادة تعيين كلمة المرور — إن مصر للصناعة',
      `طلبت إعادة تعيين كلمة مرورك. الرابط صالح لـ ١٥ دقيقة فقط.`,
      `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#D4A017">إعادة تعيين كلمة المرور</h2>
          <p>طلبت إعادة تعيين كلمة مرور حسابك في إن مصر للصناعة.</p>
          <p>انقر على الزر أدناه لإعادة التعيين. الرابط صالح لمدة <strong>١٥ دقيقة فقط</strong>.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${resetUrl}" style="background:#D4A017;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
              إعادة تعيين كلمة المرور
            </a>
          </div>
          <p style="color:#888;font-size:12px">إذا لم تطلب ذلك، تجاهل هذه الرسالة. حسابك آمن.</p>
          <p style="color:#888;font-size:12px">الرابط: ${resetUrl}</p>
        </div>
      `,
    );

    this.logger.log(`Password reset email sent to ${email.slice(0, 3)}***`);
    return { message: 'إذا كان البريد مسجلاً ستصلك رسالة خلال دقيقتين' };
  }

  // ── RESET PASSWORD ────────────────────────────────────────────
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = this.hashToken(dto.token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!record)           throw new BadRequestException('رابط إعادة التعيين غير صالح');
    if (record.isUsed)     throw new BadRequestException('تم استخدام هذا الرابط من قبل');
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('انتهت صلاحية رابط إعادة التعيين — يرجى طلب رابط جديد');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data:  { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data:  { isUsed: true },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId },
        data:  { isRevoked: true },
      }),
      this.prisma.auditLog.create({
        data: {
          userId: record.userId, action: 'PASSWORD_RESET',
          entity: 'User', entityId: record.userId,
        },
      }),
    ]);

    this.logger.log(`Password reset completed for user ${record.userId}`);
    return { message: 'تم تغيير كلمة المرور بنجاح. يرجى تسجيل الدخول بكلمة المرور الجديدة' };
  }

  // ── VALIDATE TOKEN (for frontend to check before showing form) ─
  async validateToken(token: string): Promise<{ valid: boolean; minutesLeft?: number }> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!record || record.isUsed) return { valid: false };
    if (record.expiresAt < new Date()) return { valid: false };
    const minutesLeft = Math.ceil((record.expiresAt.getTime() - Date.now()) / 60000);
    return { valid: true, minutesLeft };
  }

  // ── CHANGE PASSWORD (authenticated) ──────────────────────────
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ message: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!user.passwordHash) throw new BadRequestException('حسابك لا يستخدم كلمة مرور');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new BadRequestException('كلمة المرور الحالية غير صحيحة');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('كلمة المرور الجديدة يجب أن تكون مختلفة عن الحالية');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data:  { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });

    // Revoke all other sessions
    await this.prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data:  { isRevoked: true },
    });

    return { message: 'تم تغيير كلمة المرور بنجاح' };
  }
}

@ApiTags('auth')
@Controller('auth')
export class PasswordResetController {
  constructor(private service: PasswordResetService) {}

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'طلب إعادة تعيين كلمة المرور' })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: any) {
    return this.service.forgotPassword(dto.email, req.ip);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'إعادة تعيين كلمة المرور بالرابط' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.service.resetPassword(dto);
  }

  @Post('reset-password/validate/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'التحقق من صلاحية رابط الإعادة' })
  validateToken(@Param('token') token: string) {
    return this.service.validateToken(token);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'تغيير كلمة المرور (مسجل دخول)' })
  changePassword(@Body() dto: ChangePasswordDto, @Param() req: any) {
    return this.service.changePassword(req.user?.sub, dto);
  }
}
