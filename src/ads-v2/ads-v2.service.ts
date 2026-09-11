// ─── ads-v2/ads-v2.service.ts ──────────────────────────────────────
// نظام الإعلانات الداخلي الكامل: مساحات ثابتة + تقويم حجز + تسعير
// متدرج بالمدة + تتبع ظهور/نقر + لوحة تحكم الأونر.
//
// منفصل عمدًا عن src/ads/ads.service.ts (نظام حملات الموردين
// self-serve الأقدم) — الاتنين يخدموا احتياجات مختلفة (مساحات موردين
// بحرية vs مساحات المنصة الثابتة عالية القيمة).

import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res,
  UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { JwtGuard } from '../auth/jwt.guard';

const BILLING_MULTIPLIERS: Record<string, number> = {
  WEEKLY: 1,
  MONTHLY: 4 * 0.85,   // 15% off vs 4 straight weeks — the platform default
  QUARTERLY: 12 * 0.70, // 30% off vs 12 straight weeks + top-of-sector pinning
};

// Basic click/impression fraud guard: de-dupe the same
// (campaign, ip, day) combination in-process. Resets on restart and
// isn't shared across pm2 instances — good enough for a single-process
// deployment; a Redis-backed version would be the production upgrade.
const seenToday = new Map<string, number>();
function alreadySeen(key: string, windowMs: number): boolean {
  const now = Date.now();
  const last = seenToday.get(key);
  if (last && now - last < windowMs) return true;
  seenToday.set(key, now);
  if (seenToday.size > 50000) seenToday.clear(); // crude memory cap
  return false;
}

@Injectable()
export class AdsV2Service {
  private readonly logger = new Logger('AdsV2Service');
  constructor(private prisma: PrismaService) {}

  // ── SLOTS (fixed catalog, seeded once — see prisma/seed-ad-slots.ts) ──
  async listSlots() {
    return this.prisma.adSlot.findMany({ where: { isActive: true }, orderBy: { basePriceWeekly: 'desc' } });
  }

  // ── PRICING ────────────────────────────────────────────────────
  calculatePrice(basePriceWeekly: number, billingPeriod: string): number {
    const mult = BILLING_MULTIPLIERS[billingPeriod];
    if (!mult) throw new BadRequestException('مدة الحجز غير معروفة');
    return Math.round(basePriceWeekly * mult);
  }

  // ── AVAILABILITY ───────────────────────────────────────────────
  async checkAvailability(slotId: string, startDate: Date, endDate: Date, excludeBookingId?: string) {
    const slot = await this.prisma.adSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new NotFoundException('المساحة الإعلانية غير موجودة');

    const overlapping = await this.prisma.adBooking.count({
      where: {
        slotId,
        id: excludeBookingId ? { not: excludeBookingId } : undefined,
        reviewStatus: { in: ['PENDING_REVIEW', 'APPROVED'] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
    });

    return { available: overlapping < slot.maxConcurrentAds, slot, bookedCount: overlapping };
  }

  // ── BOOKING (advertiser-facing) ─────────────────────────────────
  async createBooking(advertiserId: string, dto: {
    slotId: string; targetSector?: string; bannerUrl: string; destinationUrl: string;
    startDate: string; endDate: string; billingPeriod: string;
  }) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('تواريخ الحجز غير صحيحة');
    }
    if (!dto.bannerUrl || !dto.destinationUrl) {
      throw new BadRequestException('ملف الإعلان ورابط الهبوط مطلوبان');
    }

    const { available, slot } = await this.checkAvailability(dto.slotId, start, end);
    if (!available) {
      throw new BadRequestException('هذه المساحة محجوزة بالكامل في الفترة المطلوبة — جربي فترة أو مساحة أخرى');
    }

    const totalPrice = this.calculatePrice(slot.basePriceWeekly, dto.billingPeriod);

    const booking = await this.prisma.adBooking.create({
      data: {
        advertiserId, slotId: dto.slotId, targetSector: dto.targetSector,
        bannerUrl: dto.bannerUrl, destinationUrl: dto.destinationUrl,
        startDate: start, endDate: end, billingPeriod: dto.billingPeriod,
        totalPrice, paymentStatus: 'UNPAID', reviewStatus: 'PENDING_REVIEW',
      },
    });

    this.logger.log(`Ad booking created: ${booking.id} (${slot.name}, ${totalPrice} EGP)`);
    return booking;
  }

  async myBookings(advertiserId: string) {
    return this.prisma.adBooking.findMany({
      where: { advertiserId },
      include: { slot: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── CALENDAR (availability preview for the booking UI) ──────────
  async getCalendar(slotId: string, monthsAhead: number) {
    const rangeEnd = new Date();
    rangeEnd.setMonth(rangeEnd.getMonth() + (monthsAhead || 3));
    return this.prisma.adBooking.findMany({
      where: {
        slotId,
        reviewStatus: { in: ['PENDING_REVIEW', 'APPROVED'] },
        startDate: { lte: rangeEnd },
      },
      select: { id: true, startDate: true, endDate: true, reviewStatus: true },
      orderBy: { startDate: 'asc' },
    });
  }

  // ── PUBLIC AD SERVING (the actual injected placements) ──────────
  async getActiveForSlot(locationKey: string, sector?: string) {
    const now = new Date();
    const slot = await this.prisma.adSlot.findUnique({ where: { locationKey: locationKey as any } });
    if (!slot) return [];

    let bookings = await this.prisma.adBooking.findMany({
      where: {
        slotId: slot.id, reviewStatus: 'APPROVED', paymentStatus: 'PAID',
        startDate: { lte: now }, endDate: { gte: now },
      },
      include: { advertiser: { select: { nameAr: true, trustScore: true, avgRating: true } } },
    });

    if (sector) {
      const sectorMatch = bookings.filter(b => !b.targetSector || b.targetSector === sector);
      bookings = sectorMatch.length ? sectorMatch : bookings.filter(b => !b.targetSector);
    }

    return bookings.slice(0, slot.maxConcurrentAds);
  }

  // ── TRACKING (with basic per-day de-dup fraud guard) ─────────────
  async recordImpression(campaignId: string, ip: string) {
    if (alreadySeen(`imp:${campaignId}:${ip}`, 60_000)) return; // 1/min/IP cap
    const today = new Date(); today.setHours(0, 0, 0, 0);
    await this.prisma.adMetric.upsert({
      where: { campaignId_date: { campaignId, date: today } },
      create: { campaignId, date: today, impressions: 1, clicks: 0 },
      update: { impressions: { increment: 1 } },
    }).catch(() => { /* campaign may not exist anymore — ignore */ });
  }

  async recordClick(campaignId: string, ip: string): Promise<string> {
    const booking = await this.prisma.adBooking.findUnique({ where: { id: campaignId } });
    if (!booking) throw new NotFoundException('الإعلان غير موجود');

    if (!alreadySeen(`clk:${campaignId}:${ip}`, 10_000)) { // 1/10s/IP cap
      const today = new Date(); today.setHours(0, 0, 0, 0);
      await this.prisma.adMetric.upsert({
        where: { campaignId_date: { campaignId, date: today } },
        create: { campaignId, date: today, impressions: 0, clicks: 1 },
        update: { clicks: { increment: 1 } },
      });
    }
    return booking.destinationUrl;
  }

  // ── ADMIN: dashboard KPIs ────────────────────────────────────────
  async adminDashboardStats() {
    const now = new Date();
    const [revenue, activeCount, pendingCount, metricsAgg] = await Promise.all([
      this.prisma.adBooking.aggregate({ where: { paymentStatus: 'PAID' }, _sum: { totalPrice: true } }),
      this.prisma.adBooking.count({ where: { reviewStatus: 'APPROVED', startDate: { lte: now }, endDate: { gte: now } } }),
      this.prisma.adBooking.count({ where: { reviewStatus: 'PENDING_REVIEW' } }),
      this.prisma.adMetric.aggregate({ _sum: { impressions: true, clicks: true } }),
    ]);
    const impressions = metricsAgg._sum.impressions || 0;
    const clicks = metricsAgg._sum.clicks || 0;
    return {
      totalRevenue: revenue._sum.totalPrice || 0,
      activeAds: activeCount,
      pendingApprovals: pendingCount,
      totalImpressions: impressions,
      totalClicks: clicks,
      avgCtr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0,
    };
  }

  // ── ADMIN: inventory table ───────────────────────────────────────
  async adminInventory(status?: string) {
    const bookings = await this.prisma.adBooking.findMany({
      where: status ? { reviewStatus: status } : undefined,
      include: {
        slot: true,
        advertiser: { select: { nameAr: true } },
        metrics: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return bookings.map(b => {
      const impressions = b.metrics.reduce((s, m) => s + m.impressions, 0);
      const clicks = b.metrics.reduce((s, m) => s + m.clicks, 0);
      return {
        id: b.id, advertiserName: b.advertiser?.nameAr, slotName: b.slot?.name,
        startDate: b.startDate, endDate: b.endDate,
        impressions, clicks,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0,
        totalPrice: b.totalPrice, paymentStatus: b.paymentStatus, reviewStatus: b.reviewStatus,
      };
    });
  }

  // ── ADMIN: review / control actions ──────────────────────────────
  async adminReview(id: string, approve: boolean, rejectionReason?: string) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    if (booking.reviewStatus !== 'PENDING_REVIEW') throw new BadRequestException('تمت مراجعة هذا الحجز بالفعل');
    return this.prisma.adBooking.update({
      where: { id },
      data: { reviewStatus: approve ? 'APPROVED' : 'REJECTED', rejectionReason: approve ? null : rejectionReason },
    });
  }

  async adminMarkPaid(id: string) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    return this.prisma.adBooking.update({ where: { id }, data: { paymentStatus: 'PAID' } });
  }

  async adminCancel(id: string) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    return this.prisma.adBooking.update({ where: { id }, data: { reviewStatus: 'CANCELLED' } });
  }

  async adminExtend(id: string, newEndDate: string) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id }, include: { slot: true } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    const end = new Date(newEndDate);
    if (isNaN(end.getTime()) || end <= booking.endDate) throw new BadRequestException('تاريخ التمديد غير صحيح');

    const { available } = await this.checkAvailability(booking.slotId, booking.endDate, end, booking.id);
    if (!available) throw new BadRequestException('المساحة محجوزة من جهة أخرى في فترة التمديد');

    const extraDays = Math.ceil((end.getTime() - booking.endDate.getTime()) / 86400000);
    const extraWeeks = Math.ceil(extraDays / 7);
    const extraPrice = Math.round(booking.slot.basePriceWeekly * extraWeeks);

    return this.prisma.adBooking.update({
      where: { id },
      data: { endDate: end, totalPrice: { increment: extraPrice }, paymentStatus: 'UNPAID' },
    });
  }
}

// ── Controller ──────────────────────────────────────────────────
@ApiTags('ads-v2')
@Controller('ads-v2')
export class AdsV2Controller {
  constructor(private ads: AdsV2Service) {}

  private requireAdmin(req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
  }

  // Public: catalog + live ad serving + tracking
  @Get('slots')
  @ApiOperation({ summary: 'كتالوج المساحات الإعلانية المتاحة' })
  listSlots() {
    return this.ads.listSlots();
  }

  @Get('slots/:slotId/calendar')
  @ApiOperation({ summary: 'تقويم توافر مساحة إعلانية' })
  getCalendar(@Param('slotId') slotId: string, @Query('months') months: string) {
    return this.ads.getCalendar(slotId, parseInt(months, 10) || 3);
  }

  @Get('serve/:locationKey')
  @ApiOperation({ summary: 'الإعلانات النشطة حاليًا لمساحة معينة (للحقن في الصفحة)' })
  serve(@Param('locationKey') locationKey: string, @Query('sector') sector: string) {
    return this.ads.getActiveForSlot(locationKey, sector);
  }

  @Post('impression/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'تسجيل ظهور إعلان' })
  async impression(@Param('id') id: string, @Req() req: any) {
    await this.ads.recordImpression(id, req.ip || 'unknown');
  }

  @Get('click/:id')
  @ApiOperation({ summary: 'تسجيل نقرة والتحويل لرابط الإعلان' })
  async click(@Param('id') id: string, @Req() req: any, @Res() res: any) {
    const url = await this.ads.recordClick(id, req.ip || 'unknown');
    res.redirect(url);
  }

  // Advertiser (authenticated company)
  @Post('bookings')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حجز مساحة إعلانية جديدة' })
  createBooking(@Body() dto: any, @Request() req: any) {
    return this.ads.createBooking(req.user.companyId, dto);
  }

  @Get('bookings/my')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حجوزاتي الإعلانية' })
  myBookings(@Request() req: any) {
    return this.ads.myBookings(req.user.companyId);
  }

  // Admin
  @Get('admin/dashboard')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'مؤشرات لوحة تحكم الإعلانات (أدمن)' })
  adminDashboard(@Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminDashboardStats();
  }

  @Get('admin/inventory')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'جدول حصر كل الحجوزات (أدمن)' })
  adminInventory(@Query('status') status: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminInventory(status);
  }

  @Post('admin/:id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'قبول/رفض حجز إعلاني (أدمن)' })
  adminReview(@Param('id') id: string, @Body() body: { approve: boolean; reason?: string }, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminReview(id, !!body.approve, body.reason);
  }

  @Post('admin/:id/mark-paid')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيل الحجز كمدفوع يدويًا (تحويل بنكي/مطابقة يدوية) — أدمن' })
  adminMarkPaid(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminMarkPaid(id);
  }

  @Post('admin/:id/cancel')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إلغاء حجز إعلاني (أدمن)' })
  adminCancel(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminCancel(id);
  }

  @Post('admin/:id/extend')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تمديد فترة حجز إعلاني (أدمن)' })
  adminExtend(@Param('id') id: string, @Body() body: { newEndDate: string }, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminExtend(id, body.newEndDate);
  }
}
