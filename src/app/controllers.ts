// ═══════════════════════════════════════════════════════════════════
// controllers/index.ts — All REST API Controllers
// ═══════════════════════════════════════════════════════════════════

import {
  Controller, Get, Post, Put, Delete, Body, Param, Query,
  UseGuards, Request, HttpCode, HttpStatus, Patch, Res, Headers, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService, RegisterDto, LoginDto, VerifyOtpDto } from '../auth/auth.service';
import { SuppliersService, SupplierQueryDto, VerificationDto } from '../suppliers/suppliers.service';
import { RfqService, CreateRfqDto, CreateQuoteDto } from '../rfq/rfq.service';
import { EscrowService, DisputeDto } from '../escrow/escrow.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AntiLeakageService } from '../common/anti-leakage.service';
import { GeoService, FinanceService, IncubatorService, OrdersService, MessagesService } from '../common/remaining-services';

// ── Auth Guards (simplified) ───────────────────────────────────────
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
class JwtGuard implements CanActivate {
  constructor(private jwt: JwtService, private config: ConfigService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return false;
    try {
      req.user = await this.jwt.verifyAsync(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
      return true;
    } catch { return false; }
  }
}

// ── Health Check ───────────────────────────────────────────────────
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'إن مصر للصناعة API',
      version: '1.0.0',
      uptime: process.uptime(),
    };
  }
}

// ── Auth Controller ────────────────────────────────────────────────
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'تسجيل حساب جديد' })
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto, @Headers('x-admin-bootstrap-secret') adminSecret?: string) {
    return this.auth.register(dto, adminSecret);
  }

  // ── Team / Assistants — owner (SUPER_ADMIN) only ─────────────────
  @Get('team')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'قائمة المساعدين الإداريين (Super Admin فقط)' })
  listTeam(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN') throw new ForbiddenException('هذا الإجراء متاح لمالك الحساب فقط');
    return this.auth.listTeamMembers();
  }

  @Post('team')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة مساعد إداري جديد (Super Admin فقط)' })
  @HttpCode(HttpStatus.CREATED)
  addTeamMember(@Body() body: { email: string; password: string }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN') throw new ForbiddenException('هذا الإجراء متاح لمالك الحساب فقط');
    return this.auth.createTeamMember(body);
  }

  @Delete('team/:id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إزالة مساعد إداري (Super Admin فقط)' })
  removeTeamMember(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN') throw new ForbiddenException('هذا الإجراء متاح لمالك الحساب فقط');
    return this.auth.removeTeamMember(id, req.user.sub);
  }

  @Post('change-password')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'تغيير كلمة المرور (للمستخدم الحالي)' })
  changePassword(@Body() body: { currentPassword?: string; newPassword: string }, @Request() req: any) {
    return this.auth.changePassword(req.user.sub, body.currentPassword, body.newPassword);
  }


  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'تسجيل الدخول' })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Request() req: any) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    return this.auth.login(dto, ip, ua);
  }

  @Post('otp/send')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'إرسال كود OTP' })
  sendOtp(@Body() body: { userId: string; purpose: string; email?: string; phone?: string }) {
    return this.auth.sendOtp(body.userId, body.purpose, body.email, body.phone);
  }

  @Post('otp/verify')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'التحقق من كود OTP' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.userId, dto.code, dto.purpose);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'تجديد access token' })
  refreshTokens(@Body() body: { refreshToken: string }, @Request() req: any) {
    return this.auth.refreshTokens(body.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيل الخروج' })
  logout(@Request() req: any) {
    return this.auth.logout(req.user.sub);
  }

  @Get('me')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'بيانات المستخدم الحالي' })
  me(@Request() req: any) {
    return { user: req.user };
  }
}

// ── Suppliers Controller ───────────────────────────────────────────
@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private suppliers: SuppliersService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة الموردين مع فلاتر' })
  @ApiResponse({ status: 200, description: 'قائمة الموردين مع pagination' })
  findAll(@Query() query: SupplierQueryDto) {
    return this.suppliers.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'ملف المورد الكامل' })
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.suppliers.findOne(id, req.user?.companyId);
  }

  @Post(':id/verify')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'رفع وثائق التحقق' })
  submitVerification(@Param('id') id: string, @Body() dto: VerificationDto, @Request() req: any) {
    if (req.user.companyId !== id) throw new Error('Forbidden');
    return this.suppliers.submitVerification(id, dto);
  }

  @Get(':id/trust-score')
  @ApiOperation({ summary: 'حساب Trust Score المورد' })
  getTrustScore(@Param('id') id: string) {
    return this.suppliers.recalculateTrustScore(id);
  }
}

// ── RFQ Controller ─────────────────────────────────────────────────
@ApiTags('rfq')
@Controller('rfq')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class RfqController {
  constructor(private rfq: RfqService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة طلبات RFQ المنشورة' })
  findAll(@Query() query: any) {
    return this.rfq.findAll(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'إنشاء طلب RFQ جديد' })
  create(@Body() dto: CreateRfqDto, @Request() req: any) {
    return this.rfq.create(req.user.companyId, dto);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'نشر مسودة RFQ' })
  publish(@Param('id') id: string, @Request() req: any) {
    return this.rfq.publish(id, req.user.companyId);
  }

  @Post(':id/quote')
  @ApiOperation({ summary: 'تقديم عرض سعر' })
  submitQuote(@Param('id') id: string, @Body() dto: CreateQuoteDto, @Request() req: any) {
    return this.rfq.submitQuote(id, req.user.companyId, dto);
  }

  @Post(':id/accept/:quoteId')
  @ApiOperation({ summary: 'قبول عرض سعر وإنشاء الطلب' })
  acceptQuote(
    @Param('id') rfqId: string,
    @Param('quoteId') quoteId: string,
    @Request() req: any,
  ) {
    return this.rfq.acceptQuote(rfqId, quoteId, req.user.companyId);
  }
}

// ── Orders Controller ──────────────────────────────────────────────
@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة طلباتي (كمشتري أو مورد)' })
  findAll(@Query() query: any, @Request() req: any) {
    return this.orders.findAll(req.user.companyId, req.user.role, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل طلب محدد' })
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.orders.findOne(id, req.user.companyId);
  }

  @Put(':id/shipment')
  @ApiOperation({ summary: 'تحديث بيانات الشحن (المورد فقط)' })
  updateShipment(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    return this.orders.updateShipment(id, req.user.companyId, dto);
  }

  @Post(':id/documents')
  @ApiOperation({ summary: 'رفع وثائق الطلب' })
  uploadDocument(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    return this.orders.addDocument(id, req.user.id, dto);
  }
}

// ── Escrow Controller ──────────────────────────────────────────────
@ApiTags('escrow')
@Controller('escrow')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class EscrowController {
  constructor(private escrow: EscrowService) {}

  @Post(':orderId/fund')
  @ApiOperation({ summary: 'دفع وتحميل الـ Escrow' })
  fund(
    @Param('orderId') orderId: string,
    @Body() body: { gatewayToken: string },
    @Request() req: any,
  ) {
    return this.escrow.fund(orderId, req.user.companyId, body.gatewayToken);
  }

  @Post(':orderId/release')
  @ApiOperation({ summary: 'تأكيد الاستلام والإفراج عن الأموال' })
  release(@Param('orderId') orderId: string, @Request() req: any) {
    return this.escrow.release(orderId, req.user.companyId);
  }

  @Post(':orderId/dispute')
  @ApiOperation({ summary: 'رفع نزاع على الطلب' })
  dispute(
    @Param('orderId') orderId: string,
    @Body() dto: DisputeDto,
    @Request() req: any,
  ) {
    return this.escrow.dispute(orderId, req.user.id, dto);
  }
}

// ── Messages Controller ────────────────────────────────────────────
@ApiTags('messages')
@Controller('messages')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class MessagesController {
  constructor(private messages: MessagesService) {}

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'محادثة الطلب' })
  getThread(@Param('orderId') orderId: string, @Request() req: any) {
    return this.messages.getThread(orderId, req.user.id);
  }

  @Post('orders/:orderId')
  @ApiOperation({ summary: 'إرسال رسالة جديدة' })
  send(
    @Param('orderId') orderId: string,
    @Body() body: { content: string; attachments?: any[] },
    @Request() req: any,
  ) {
    return this.messages.send(orderId, req.user.id, body.content, body.attachments);
  }

  @Patch('orders/:orderId/read')
  @ApiOperation({ summary: 'تعليم الرسائل كمقروءة' })
  markRead(@Param('orderId') orderId: string, @Request() req: any) {
    return this.messages.markRead(orderId, req.user.id);
  }
}

// ── Geo Controller ─────────────────────────────────────────────────
@ApiTags('geo')
@Controller('geo')
export class GeoController {
  constructor(private geo: GeoService) {}

  @Get('suppliers')
  @ApiOperation({ summary: 'الموردون على الخريطة' })
  getMapSuppliers(@Query() query: {
    lat?: number; lng?: number;
    radiusKm?: number; sector?: string;
  }) {
    return this.geo.getMapData(query);
  }

  @Get('zones')
  @ApiOperation({ summary: 'قائمة المناطق الصناعية' })
  getZones() {
    return this.geo.getIndustrialZones();
  }

  @Get('shipping-estimate')
  @ApiOperation({ summary: 'تقدير تكلفة الشحن' })
  shippingEstimate(@Query() q: { fromLat: number; fromLng: number; toLat: number; toLng: number; weightTons: number }) {
    return this.geo.estimateShipping(q);
  }
}

// ── Finance Controller ─────────────────────────────────────────────
@ApiTags('finance')
@Controller('finance')
export class FinanceController {
  constructor(private finance: FinanceService) {}

  @Get('plans')
  @ApiOperation({ summary: 'خطط التمويل المتاحة' })
  getPlans() { return this.finance.getPlans(); }

  @Post('calculate')
  @ApiOperation({ summary: 'حساب القسط الشهري' })
  calculate(@Body() body: { amount: number; months: number; rate: number }) {
    return this.finance.calculatePayment(body.amount, body.months, body.rate);
  }

  @Post('apply')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقديم طلب تمويل' })
  apply(@Body() dto: any, @Request() req: any) {
    return this.finance.applyForFinance(req.user.companyId, dto);
  }

  @Get('applications')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'طلبات التمويل الخاصة بي' })
  myApplications(@Request() req: any) {
    return this.finance.getApplications(req.user.companyId);
  }
}

// ── Incubator Controller ───────────────────────────────────────────
@ApiTags('incubator')
@Controller('incubator')
export class IncubatorController {
  constructor(private incubator: IncubatorService) {}

  @Get('opportunities')
  @ApiOperation({ summary: 'الفرص الاستثمارية المرصودة' })
  getOpportunities(@Query() q: { sector?: string; region?: string; maxInvestment?: number }) {
    return this.incubator.getOpportunities(q);
  }

  @Get('opportunities/:id/feasibility')
  @ApiOperation({ summary: 'دراسة الجدوى الكاملة' })
  getFeasibility(@Param('id') id: string) {
    return this.incubator.getFeasibilityStudy(id);
  }

  @Get('opportunities/:id/ready-factories')
  @ApiOperation({ summary: 'المصانع الجاهزة للشراء' })
  getReadyFactories(@Param('id') id: string) {
    return this.incubator.getReadyFactories(id);
  }

  @Post('opportunities/:id/interest')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيل اهتمام بفرصة' })
  registerInterest(@Param('id') id: string, @Request() req: any) {
    return this.incubator.registerInterest(id, req.user.companyId);
  }

  @Get('gaps')
  @ApiOperation({ summary: 'فجوات السوق من بيانات RFQ' })
  getMarketGaps() {
    return this.incubator.analyzeMarketGaps();
  }

  // ── Admin: manage feasibility studies (owner dashboard) ──────────
  @Get('admin/studies')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل دراسات الجدوى بما فيها المسودات (أدمن)' })
  adminListStudies(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.incubator.adminListStudies();
  }

  @Post('admin/studies')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة دراسة جدوى جديدة (أدمن)' })
  createStudy(@Body() dto: any, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.incubator.createStudy(dto);
  }

  @Patch('admin/studies/:id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل دراسة جدوى (أدمن)' })
  updateStudy(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.incubator.updateStudy(id, dto);
  }

  @Delete('admin/studies/:id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حذف دراسة جدوى (أدمن)' })
  deleteStudy(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.incubator.deleteStudy(id);
  }
}

// ── Notifications Controller ───────────────────────────────────────
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة إشعاراتي' })
  getAll(@Query() q: { page?: number; limit?: number }, @Request() req: any) {
    return this.notifications.getUserNotifications(req.user.sub, q.page, q.limit);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'تعليم إشعار كمقروء' })
  markRead(@Param('id') id: string, @Request() req: any) {
    return this.notifications.markAsRead(id, req.user.sub);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'تعليم كل الإشعارات كمقروءة' })
  markAllRead(@Request() req: any) {
    return this.notifications.markAllAsRead(req.user.sub);
  }
}

// ── Anti-Leakage Controller (Admin) ───────────────────────────────
@ApiTags('anti-leakage')
@Controller('admin/anti-leakage')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class AntiLeakageController {
  constructor(private antiLeakage: AntiLeakageService) {}

  @Post('test')
  @ApiOperation({ summary: 'اختبار الفلتر على نص' })
  testFilter(@Body() body: { content: string }) {
    return this.antiLeakage.sanitize(body.content);
  }

  @Get('stats')
  @ApiOperation({ summary: 'إحصائيات محرك منع التسريب' })
  getStats() {
    return this.antiLeakage.getStats();
  }
}
