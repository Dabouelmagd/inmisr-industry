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
import { GeoService, FinanceService, InspectionService, TrainingService, FactoryNeedService, ReverseLogisticsService, JobPostingService, SmeProjectService, PromoCodeService, TradeApplicationService, SpecialOfferService, SolarLeadService, ServiceConsultationService, ProviderListingService, CompanyAssistantService, IncubatorService, OrdersService, MessagesService } from '../common/remaining-services';

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

  @Get('admin/applications')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات التمويل (أدمن)' })
  adminApplications(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.finance.adminListApplications(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على طلب تمويل أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.finance.adminReview(id, !!body.approve);
  }
}

// ── Inspection Controller ────────────────────────────────────────
@ApiTags('inspection')
@Controller('inspection')
export class InspectionController {
  constructor(private inspection: InspectionService) {}

  @Post('testing')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حجز طلب فحص معملي' })
  submitTesting(@Body() dto: any, @Request() req: any) {
    return this.inspection.submitTesting(req.user.companyId, dto);
  }

  @Post('audit')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حجز طلب تفتيش ميداني' })
  submitAudit(@Body() dto: any, @Request() req: any) {
    return this.inspection.submitAudit(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'طلبات الفحص والتفتيش الخاصة بي' })
  listMine(@Request() req: any) {
    return this.inspection.listMine(req.user.companyId);
  }

  @Get('admin/requests')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات الفحص والتفتيش (أدمن)' })
  adminList(@Query('kind') kind: string, @Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.inspection.adminList(kind, status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على طلب فحص/تفتيش أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean; notes?: string }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.inspection.adminReview(id, !!body.approve, body.notes);
  }
}

// ── Training Controller ──────────────────────────────────────────
@ApiTags('training')
@Controller('training')
export class TrainingController {
  constructor(private training: TrainingService) {}

  @Post('enroll')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'التسجيل في دورة تدريبية' })
  enroll(@Body() body: { courseName: string }, @Request() req: any) {
    return this.training.enroll(req.user.companyId, body.courseName);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيلاتي في الدورات' })
  listMine(@Request() req: any) {
    return this.training.listMine(req.user.companyId);
  }

  @Get('admin/enrollments')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل تسجيلات الدورات (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.training.adminList(status);
  }

  @Post('admin/:id/cancel')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إلغاء تسجيل دورة (أدمن)' })
  adminCancel(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.training.adminCancel(id);
  }
}

// ── Factory Needs Controller ─────────────────────────────────────
@ApiTags('factory-needs')
@Controller('factory-needs')
export class FactoryNeedController {
  constructor(private factoryNeeds: FactoryNeedService) {}

  @Get()
  @ApiOperation({ summary: 'طلبات الاحتياج المنشورة (عامة)' })
  listPublic() {
    return this.factoryNeeds.listPublic();
  }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'نشر طلب احتياج جديد' })
  submit(@Body() dto: any, @Request() req: any) {
    return this.factoryNeeds.submit(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'طلبات الاحتياج الخاصة بمنشأتي' })
  listMine(@Request() req: any) {
    return this.factoryNeeds.listMine(req.user.companyId);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات الاحتياج (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.factoryNeeds.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على طلب احتياج أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.factoryNeeds.adminReview(id, !!body.approve);
  }
}

// ── Reverse Logistics Controller ─────────────────────────────────
@ApiTags('reverse-logistics')
@Controller('reverse-logistics')
export class ReverseLogisticsController {
  constructor(private reverse: ReverseLogisticsService) {}

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيل طلب استرجاع / مرتجعات' })
  submit(@Body() dto: any, @Request() req: any) {
    return this.reverse.submit(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'طلبات الاسترجاع الخاصة بي' })
  listMine(@Request() req: any) {
    return this.reverse.listMine(req.user.companyId);
  }

  @Get('admin/requests')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات الاسترجاع (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.reverse.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على طلب استرجاع أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.reverse.adminReview(id, !!body.approve);
  }
}

// ── Job Posting Controller ───────────────────────────────────────
@ApiTags('job-postings')
@Controller('job-postings')
export class JobPostingController {
  constructor(private jobs: JobPostingService) {}

  @Get()
  @ApiOperation({ summary: 'إعلانات الوظائف المنشورة (عامة)' })
  listPublic() {
    return this.jobs.listPublic();
  }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'نشر إعلان وظيفة جديد' })
  submit(@Body() dto: any, @Request() req: any) {
    return this.jobs.submit(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إعلانات الوظائف الخاصة بمنشأتي' })
  listMine(@Request() req: any) {
    return this.jobs.listMine(req.user.companyId);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل إعلانات الوظائف (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.jobs.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على إعلان وظيفة أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.jobs.adminReview(id, !!body.approve);
  }
}

// ── Company Assistant Controller (business team invites & permissions) ──
@ApiTags('company-assistants')
@Controller('company-assistants')
export class CompanyAssistantController {
  constructor(private assistants: CompanyAssistantService) {}

  @Post('invite')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'دعوة مساعد جديد لحساب الشركة' })
  invite(@Body() dto: any, @Request() req: any) {
    if (!req.user.companyId) throw new ForbiddenException('يجب تسجيل حساب شركة أولاً');
    return this.assistants.invite(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'قائمة مساعدي حسابي' })
  listMine(@Request() req: any) {
    if (!req.user.companyId) throw new ForbiddenException('يجب تسجيل حساب شركة أولاً');
    return this.assistants.listMine(req.user.companyId);
  }

  @Patch(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل صلاحيات مساعد' })
  update(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    return this.assistants.updatePermissions(req.user.companyId, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إزالة مساعد وتعطيل حسابه' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.assistants.remove(req.user.companyId, id);
  }

  @Post(':id/resend-invite')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إعادة إرسال رابط الدعوة' })
  resend(@Param('id') id: string, @Request() req: any) {
    return this.assistants.resendInvite(req.user.companyId, id);
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'قبول دعوة مساعد وتفعيل الحساب (بدون تسجيل دخول)' })
  acceptInvite(@Body() body: { token: string; password: string }) {
    return this.assistants.acceptInvite(body.token, body.password);
  }
}

// ── Provider Listing Controller (registered shipping/packaging providers) ──
@ApiTags('provider-listings')
@Controller('provider-listings')
export class ProviderListingController {
  constructor(private providers: ProviderListingService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة مقدمي الخدمة المعتمدين (عامة)' })
  listPublic(@Query('category') category: string) {
    return this.providers.listPublic(category);
  }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة خدمة شحن/تغليف — يتطلب حساب شركة مسجّل' })
  create(@Body() dto: any, @Request() req: any) {
    if (!req.user.companyId) throw new ForbiddenException('يجب تسجيل حساب شركة أولاً لإضافة خدمة');
    return this.providers.create(req.user.companyId, dto.category, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'خدماتي المسجّلة' })
  listMine(@Request() req: any) {
    if (!req.user.companyId) throw new ForbiddenException('يجب تسجيل حساب شركة أولاً');
    return this.providers.listMine(req.user.companyId);
  }

  @Patch(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل خدمة مسجّلة (تُعاد للمراجعة)' })
  update(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    return this.providers.update(req.user.companyId, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حذف خدمة مسجّلة' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.providers.remove(req.user.companyId, id);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل خدمات الشحن/التغليف المسجّلة (أدمن)' })
  adminList(@Query('category') category: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.providers.adminList(category);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على خدمة مقدم أو رفضها (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.providers.adminReview(id, !!body.approve);
  }
}

// ── Service Consultation Controller (shipping + custom packaging leads) ──
@ApiTags('service-consultations')
@Controller('service-consultations')
export class ServiceConsultationController {
  constructor(private consult: ServiceConsultationService) {}

  @Post('shipping')
  @ApiOperation({ summary: 'طلب مشورة لوجستية (بدون تسجيل دخول)' })
  submitShipping(@Body() dto: any) {
    return this.consult.submit('SHIPPING', { companyName: dto.companyName, phone: dto.phone, details: dto.details });
  }

  @Post('packaging')
  @ApiOperation({ summary: 'طلب تغليف مخصص (بدون تسجيل دخول)' })
  submitPackaging(@Body() dto: any) {
    return this.consult.submit('PACKAGING', { companyName: dto.companyName, phone: dto.phone, details: dto.details });
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات الاستشارة (أدمن)' })
  adminList(@Query('kind') kind: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.consult.adminList(kind);
  }

  @Post('admin/:id/status')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تحديث حالة طلب استشارة (أدمن)' })
  adminUpdateStatus(@Param('id') id: string, @Body() body: { status: string }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.consult.adminUpdateStatus(id, body.status);
  }
}

// ── Solar Lead Controller (public "شمسك.. طاقتك" leads) ───────────
@ApiTags('solar-leads')
@Controller('solar-leads')
export class SolarLeadController {
  constructor(private solar: SolarLeadService) {}

  @Post()
  @ApiOperation({ summary: 'تقديم طلب استشارة طاقة شمسية (بدون تسجيل دخول)' })
  submit(@Body() dto: any) {
    return this.solar.submit(dto);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات الطاقة الشمسية (أدمن)' })
  adminList(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.solar.adminList();
  }

  @Post('admin/:id/status')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تحديث حالة طلب طاقة شمسية (أدمن)' })
  adminUpdateStatus(@Param('id') id: string, @Body() body: { status: string }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.solar.adminUpdateStatus(id, body.status);
  }
}

// ── Special Offer Controller ─────────────────────────────────────
@ApiTags('special-offers')
@Controller('special-offers')
export class SpecialOfferController {
  constructor(private offers: SpecialOfferService) {}

  @Get()
  @ApiOperation({ summary: 'العروض الخاصة المعتمدة (عامة)' })
  listPublic(@Query('sector') sector: string) {
    return this.offers.listPublic(sector);
  }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقديم عرض خاص جديد' })
  submit(@Body() dto: any, @Request() req: any) {
    return this.offers.submit(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'عروضي الخاصة' })
  listMine(@Request() req: any) {
    return this.offers.listMine(req.user.companyId);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل العروض الخاصة (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.offers.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على عرض خاص أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.offers.adminReview(id, !!body.approve);
  }
}

// ── SME Project Controller ───────────────────────────────────────
@ApiTags('sme-projects')
@Controller('sme-projects')
export class SmeProjectController {
  constructor(private sme: SmeProjectService) {}

  @Get()
  @ApiOperation({ summary: 'مشروعات الشباب المعتمدة (عامة)' })
  listPublic() {
    return this.sme.listPublic();
  }

  @Post()
  @ApiOperation({ summary: 'إرسال مشروع للحاضنة (بدون تسجيل دخول)' })
  submit(@Body() dto: any) {
    return this.sme.submit(dto);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل مشروعات الشباب (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.sme.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على مشروع أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.sme.adminReview(id, !!body.approve);
  }

  @Post('admin/:id/toggle-visibility')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إظهار/إخفاء مشروع معتمد (أدمن)' })
  toggleVisibility(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.sme.toggleVisibility(id);
  }
}

// ── Promo Code Controller (owner dashboard "أكواد العملاء") ──────
@ApiTags('promo-codes')
@Controller('promo-codes')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class PromoCodeController {
  constructor(private promo: PromoCodeService) {}

  private requireAdmin(req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
  }

  @Get()
  @ApiOperation({ summary: 'كل أكواد الخصم (أدمن)' })
  list(@Request() req: any) {
    this.requireAdmin(req);
    return this.promo.list();
  }

  @Post()
  @ApiOperation({ summary: 'إنشاء كود خصم جديد (أدمن)' })
  create(@Body() dto: { type: string; plan: string; uses?: number; note?: string }, @Request() req: any) {
    this.requireAdmin(req);
    return this.promo.create(req.user.sub, dto);
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'إلغاء كود خصم (أدمن)' })
  revoke(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.promo.revoke(id);
  }
}

// ── Trade Application Controller (job-seekers, no account needed) ──
@ApiTags('trade-applications')
@Controller('trade-applications')
export class TradeApplicationController {
  constructor(private trade: TradeApplicationService) {}

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقديم فردي على وظيفة أو فرصة حرفية (يتطلب حساب باحث عن عمل)' })
  submit(@Body() dto: any, @Request() req: any) {
    if (!req.user.workerId) {
      throw new ForbiddenException('هذا الإجراء متاح لحسابات الباحثين عن عمل فقط');
    }
    return this.trade.submit(req.user.workerId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقديماتي وطلبات التحاقي بالتدريب' })
  listMine(@Request() req: any) {
    if (!req.user.workerId) {
      throw new ForbiddenException('هذا الإجراء متاح لحسابات الباحثين عن عمل فقط');
    }
    return this.trade.listMine(req.user.workerId);
  }

  @Get('admin/all')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل الطلبات الفردية (أدمن)' })
  adminList(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.trade.adminList();
  }

  @Post('admin/:id/toggle-contacted')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تبديل حالة التواصل مع المتقدم (أدمن)' })
  toggleContacted(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.trade.adminToggleContacted(id);
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
