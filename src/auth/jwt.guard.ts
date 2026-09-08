// ─── guards/jwt.guard.ts ──────────────────────────────────────────
import {
  Injectable, CanActivate, ExecutionContext,
  UnauthorizedException, SetMetadata,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

// ── JWT Auth Guard ─────────────────────────────────────────────────
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private jwt:       JwtService,
    private config:    ConfigService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Skip public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('التوثيق مطلوب');

    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
      (req as any).user = payload;
      return true;
    } catch (err) {
      throw new UnauthorizedException(
        err.name === 'TokenExpiredError' ? 'انتهت صلاحية الجلسة — يرجى تسجيل الدخول مجدداً' : 'رمز مصادقة غير صالح'
      );
    }
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    // Also check cookie
    const cookie = (req as any).cookies?.access_token;
    return cookie || null;
  }
}

// ── Roles Guard ───────────────────────────────────────────────────
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) return false;

    if (!required.includes(user.role)) {
      throw new UnauthorizedException(
        `الوصول محدود — الأدوار المسموح بها: ${required.join(', ')}`
      );
    }
    return true;
  }
}

// ─── guards/subscription.guard.ts ────────────────────────────────
// Enforce subscription limits per plan
import { ForbiddenException } from '@nestjs/common';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly PLAN_FEATURES: Record<string, Record<string, any>> = {
    FREE:   { maxProducts: 10,  maxRfqResponses: 5,   canViewAnalytics: false, canRunAds: false },
    GROWTH: { maxProducts: 200, maxRfqResponses: 50,  canViewAnalytics: true,  canRunAds: true  },
    ELITE:  { maxProducts: Infinity, maxRfqResponses: Infinity, canViewAnalytics: true, canRunAds: true },
  };

  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const feature = this.reflector.get<string>('requiredFeature', ctx.getHandler());
    if (!feature) return true;

    const { user } = ctx.switchToHttp().getRequest();
    const plan = user?.plan || 'FREE';
    const features = this.PLAN_FEATURES[plan] || this.PLAN_FEATURES.FREE;

    if (!features[feature]) {
      throw new ForbiddenException(
        `هذه الميزة غير متاحة في خطتك الحالية (${plan}). يرجى ترقية الاشتراك.`
      );
    }
    return true;
  }
}
export const RequireFeature = (f: string) => SetMetadata('requiredFeature', f);
