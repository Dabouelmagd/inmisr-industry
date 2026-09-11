// ─── finance/financing.service.ts ─────────────────────────────────
// طلبات التمويل الصناعي — تقديم، حساب القسط، مراجعة الأدمن
// يُستخدم من صفحة "التمويل الصناعي" العامة + تبويب "طلبات الخدمات
// الصناعية" في لوحة تحكم الأونر

import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Controller, Get, Post, Body, Param, Query, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtGuard } from '../auth/jwt.guard';

// Fixed partner rates — matches the public calculator on page-financing
// exactly (see calcFinancing() in the frontend). "مرن" lets the platform
// pick the best available rate on the applicant's behalf.
const BANK_PARTNERS: Record<string, number> = {
  'CIB': 14,
  'بنك التنمية الصناعية': 11,
  'QNB الأهلي': 16,
  'مرن — حسب أفضل عرض': 11,
};

@Injectable()
export class FinancingService {
  private readonly logger = new Logger(FinancingService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // Same amortization formula as the frontend calculator — computed
  // server-side too so the stored monthlyPayment can't be spoofed by
  // the client and always matches the actual bank/duration chosen.
  calculateMonthlyPayment(amount: number, months: number, annualRatePct: number): number {
    const monthlyRate = annualRatePct / 12 / 100;
    if (monthlyRate === 0) return amount / months;
    return (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
  }

  async apply(companyId: string, dto: ApplyFinancingDto) {
    const rate = BANK_PARTNERS[dto.bankPartner];
    if (rate === undefined) {
      throw new BadRequestException('جهة التمويل غير معروفة');
    }
    if (dto.amount <= 0 || dto.durationMonths <= 0) {
      throw new BadRequestException('المبلغ ومدة السداد يجب أن يكونا أكبر من صفر');
    }

    const monthlyPayment = this.calculateMonthlyPayment(dto.amount, dto.durationMonths, rate);

    const application = await this.prisma.financeApplication.create({
      data: {
        companyId,
        amount: dto.amount,
        durationMonths: dto.durationMonths,
        interestRate: rate,
        monthlyPayment: +monthlyPayment.toFixed(2),
        bankPartner: dto.bankPartner,
        purpose: dto.purpose,
        status: 'PENDING',
      },
    });

    this.logger.log(`Financing application created: ${application.id} for company ${companyId}`);
    return application;
  }

  async listMine(companyId: string) {
    return this.prisma.financeApplication.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.financeApplication.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, adminId: string, approve: boolean) {
    const application = await this.prisma.financeApplication.findUnique({
      where: { id },
      include: { company: { include: { user: true } } },
    });
    if (!application) throw new NotFoundException('طلب التمويل غير موجود');
    if (application.status !== 'PENDING') {
      throw new BadRequestException('تمت مراجعة هذا الطلب بالفعل');
    }

    const updated = await this.prisma.financeApplication.update({
      where: { id },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        approvedAt: approve ? new Date() : null,
      },
    });

    const applicantUser = application.company?.user;
    if (applicantUser) {
      await this.notifications.send(
        applicantUser.id, 'SYSTEM',
        approve ? 'تمت الموافقة على طلب التمويل' : 'تم رفض طلب التمويل',
        approve
          ? `تمت الموافقة على طلب تمويل بقيمة ${application.amount} ج.م عبر ${application.bankPartner} — سيتواصل معك فريق البنك لاستكمال الإجراءات.`
          : `للأسف تم رفض طلب التمويل بقيمة ${application.amount} ج.م. يمكنك التقديم مرة أخرى ببيانات مختلفة.`,
        { applicationId: id },
      ).catch(() => { /* notification failure shouldn't block the review action */ });
    }

    return updated;
  }
}

class ApplyFinancingDto {
  @IsNumber() @Min(1) amount: number;
  @IsNumber() @Min(1) durationMonths: number;
  @IsString() bankPartner: string;
  @IsString() @IsOptional() purpose?: string;
}

@ApiTags('financing')
@Controller('finance')
export class FinancingController {
  constructor(private financing: FinancingService) {}

  @Post('apply')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقديم طلب تمويل صناعي' })
  @HttpCode(HttpStatus.CREATED)
  apply(@Body() dto: ApplyFinancingDto, @Request() req: any) {
    return this.financing.apply(req.user.companyId, dto);
  }

  @Get('my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'طلبات التمويل الخاصة بمنشأتي' })
  listMine(@Request() req: any) {
    return this.financing.listMine(req.user.companyId);
  }

  @Get('admin/applications')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'كل طلبات التمويل (أدمن)' })
  adminList(@Query('status') status: string, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.financing.adminList(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على طلب تمويل أو رفضه (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.financing.adminReview(id, req.user.sub, !!body.approve);
  }
}
