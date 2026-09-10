// ─── admin/admin.controller.ts ────────────────────────────────────
import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, Request, ForbiddenException, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { ReportsService } from '../admin/reports.service';
import { JwtGuard } from '../auth/jwt.guard';

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class AdminController {
  constructor(
    private admin:   AdminService,
    private reports: ReportsService,
  ) {}

  // ── Guard: Admin-only ─────────────────────────────────────────
  private requireAdmin(req: any) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('ليس لديك صلاحية الوصول لهذه الصفحة');
    }
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'إحصائيات لوحة التحكم الرئيسية' })
  getDashboard(@Request() req: any) {
    this.requireAdmin(req);
    return this.admin.getDashboardStats();
  }

  @Get('escrow')
  @ApiOperation({ summary: 'إحصائيات Escrow (محتجز، مُفرج عنه، متنازع عليه)' })
  getEscrow(@Request() req: any) {
    this.requireAdmin(req);
    return this.admin.getEscrowStats();
  }

  // ── DISPUTES ─────────────────────────────────────────────────
  @Get('disputes')
  @ApiOperation({ summary: 'قائمة النزاعات' })
  getDisputes(@Query() q: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.getDisputes({ status: q.status, page: q.page, limit: q.limit });
  }

  @Post('disputes/:id/resolve')
  @ApiOperation({ summary: 'حل نزاع' })
  resolveDispute(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.resolveDispute(id, req.user.sub, dto);
  }

  // ── VERIFICATIONS ─────────────────────────────────────────────
  @Get('verifications')
  @ApiOperation({ summary: 'طلبات التحقق المعلقة' })
  getVerifications(@Query() q: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.getVerifications({ status: q.status, page: q.page, limit: q.limit });
  }

  @Patch('verifications/:id/review')
  @ApiOperation({ summary: 'مراجعة وثيقة تحقق' })
  reviewVerification(@Param('id') id: string, @Body() dto: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.reviewVerification(id, req.user.sub, dto);
  }

  // ── USERS ─────────────────────────────────────────────────────
  @Post('users/:id/ban')
  @ApiOperation({ summary: 'إيقاف مستخدم' })
  banUser(@Param('id') id: string, @Body() dto: { reason: string }, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.banUser(id, req.user.sub, dto.reason);
  }

  @Post('users/:id/unban')
  @ApiOperation({ summary: 'رفع الإيقاف عن مستخدم' })
  unbanUser(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.admin.unbanUser(id, req.user.sub);
  }

  // ── REPORTS ───────────────────────────────────────────────────
  @Get('reports/commissions')
  @ApiOperation({ summary: 'تقرير العمولات' })
  getCommissionReport(@Query() q: any, @Request() req: any) {
    this.requireAdmin(req);
    const from = q.from ? new Date(q.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to   = q.to   ? new Date(q.to)   : new Date();
    return this.admin.getCommissionReport(from, to);
  }

  @Get('reports/supplier/:companyId')
  @ApiOperation({ summary: 'تقرير أداء مورد' })
  async getSupplierReport(@Param('companyId') companyId: string, @Query() q: any, @Request() req: any) {
    this.requireAdmin(req);
    const from = q.from ? new Date(q.from) : new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1);
    const to   = q.to   ? new Date(q.to)   : new Date();
    const data = await this.reports.generateSupplierReport(companyId, { from, to });
    if (q.format === 'html') return { html: this.reports.generateReportHtml(data, 'SUPPLIER_PERFORMANCE') };
    return data;
  }

  @Get('reports/buyer/:companyId')
  @ApiOperation({ summary: 'تقرير نشاط مشتري' })
  async getBuyerReport(@Param('companyId') companyId: string, @Query() q: any, @Request() req: any) {
    this.requireAdmin(req);
    const from = q.from ? new Date(q.from) : new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1);
    const to   = q.to   ? new Date(q.to)   : new Date();
    const data = await this.reports.generateBuyerReport(companyId, { from, to });
    if (q.format === 'html') return { html: this.reports.generateReportHtml(data, 'BUYER_ACTIVITY') };
    return data;
  }
}

// ─── Additional controllers ───────────────────────────────────────
import { LoyaltyService } from '../loyalty/loyalty.service';
import { TwoFaService } from '../auth/twofa.service';
import { InvoiceService } from '../finance/invoice.service';

@ApiTags('loyalty')
@Controller('loyalty')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class LoyaltyController {
  constructor(private loyalty: LoyaltyService) {}

  @Get('summary')
  @ApiOperation({ summary: 'ملخص نقاط الولاء' })
  getSummary(@Request() req: any) {
    return this.loyalty.getSummary(req.user.companyId);
  }

  @Get('tiers')
  @ApiOperation({ summary: 'مستويات نظام الولاء' })
  getTiers() {
    return { tiers: this.loyalty.getTiers(), discounts: this.loyalty.getDiscountTiers() };
  }

  @Post('redeem')
  @ApiOperation({ summary: 'استرداد نقاط' })
  redeem(@Body() dto: { points: number; orderId: string }, @Request() req: any) {
    return this.loyalty.redeemPoints(req.user.companyId, dto.points, dto.orderId);
  }

  @Get('discount/:supplierCompanyId')
  @ApiOperation({ summary: 'خصم الطلبات المتكررة' })
  getDiscount(@Param('supplierCompanyId') supplierId: string, @Request() req: any) {
    return this.loyalty.getRecurringDiscount(req.user.companyId, supplierId);
  }
}

@ApiTags('2fa')
@Controller('auth/2fa')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class TwoFaController {
  constructor(private twofa: TwoFaService) {}

  @Post('setup')
  @ApiOperation({ summary: 'إعداد المصادقة الثنائية — يُولّد QR code' })
  setup(@Request() req: any) {
    return this.twofa.setupTwoFa(req.user.sub);
  }

  @Post('activate')
  @ApiOperation({ summary: 'تفعيل المصادقة الثنائية — يُولّد رموز احتياطية' })
  activate(@Body() dto: { code: string }, @Request() req: any) {
    return this.twofa.activateTwoFa(req.user.sub, dto.code);
  }

  @Post('verify')
  @ApiOperation({ summary: 'التحقق من كود 2FA' })
  verify(@Body() dto: { code: string }, @Request() req: any) {
    return this.twofa.verifyTwoFa(req.user.sub, dto.code);
  }

  @Post('disable')
  @ApiOperation({ summary: 'إلغاء تفعيل المصادقة الثنائية' })
  disable(@Body() dto: { code: string; password: string }, @Request() req: any) {
    return this.twofa.disableTwoFa(req.user.sub, dto.code, dto.password);
  }

  @Post('backup-codes/regenerate')
  @ApiOperation({ summary: 'إعادة توليد الرموز الاحتياطية' })
  regenBackup(@Body() dto: { code: string }, @Request() req: any) {
    return this.twofa.regenerateBackupCodes(req.user.sub, dto.code);
  }
}

@ApiTags('invoices')
@Controller('invoices')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class InvoicesController {
  constructor(private invoice: InvoiceService) {}

  @Post('orders/:orderId/issue')
  @ApiOperation({ summary: 'إصدار فاتورة إلكترونية لطلب' })
  issueInvoice(@Param('orderId') orderId: string) {
    return this.invoice.issueInvoice(orderId);
  }

  @Get(':etaUuid/status')
  @ApiOperation({ summary: 'حالة الفاتورة في منظومة ETA' })
  getStatus(@Param('etaUuid') uuid: string) {
    return this.invoice.getInvoiceStatus(uuid);
  }
}
