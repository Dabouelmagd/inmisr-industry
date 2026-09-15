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
  UseGuards, Request, HttpCode, HttpStatus, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { join, extname } from 'path';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { AdminService } from '../admin/admin.service';
import { JwtGuard } from '../auth/jwt.guard';

const BILLING_MULTIPLIERS: Record<string, number> = {
  WEEKLY: 1,
  MONTHLY: 4 * 0.85,   // 15% off vs 4 straight weeks — the platform default
  QUARTERLY: 12 * 0.70, // 30% off vs 12 straight weeks + top-of-sector pinning
  SEMI_ANNUAL: 26 * 0.60, // 40% off vs 26 straight weeks (6 months)
  ANNUAL: 52 * 0.50, // 50% off vs 52 straight weeks (1 year) — the deepest discount tier
};

// The number of days a booking actually occupies the slot for, per period —
// must correspond exactly to what BILLING_MULTIPLIERS charges for, or a
// WEEKLY-priced booking could occupy the slot far longer than one week.
const BILLING_PERIOD_DAYS: Record<string, number> = {
  WEEKLY: 7,
  MONTHLY: 28,
  QUARTERLY: 84,
  SEMI_ANNUAL: 182,
  ANNUAL: 364,
};

// Anomaly-detection thresholds (per the spec: spike >8-10% CTR is
// fraud-suspicious; <0.2% CTR after 2000+ impressions is underperforming).
const SPIKE_CTR_THRESHOLD = 10;      // %
const SPIKE_MIN_IMPRESSIONS = 50;    // minimum sample before judging a spike
const UNDERPERFORM_CTR_THRESHOLD = 0.2; // %
const UNDERPERFORM_MIN_IMPRESSIONS = 2000;

async function dispatchAlertWebhook(message: string) {
  const url = process.env.ADS_ALERT_WEBHOOK_URL;
  if (!url || typeof fetch === 'undefined') return; // not configured, or Node <18 without global fetch
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }), // Slack-compatible shape; most webhook relays accept this
    });
  } catch { /* best-effort only — never let a failed webhook break the request */ }
}

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
    const slots = await this.prisma.adSlot.findMany({ where: { isActive: true }, orderBy: { basePriceWeekly: 'desc' } });
    const now = new Date();
    const withOccupancy = await Promise.all(slots.map(async (slot) => {
      const activeCount = await this.prisma.adBooking.count({
        where: {
          slotId: slot.id,
          reviewStatus: 'APPROVED',
          startDate: { lte: now },
          endDate: { gte: now },
        },
      });
      return { ...slot, activeCount, availableCount: Math.max(0, slot.maxConcurrentAds - activeCount) };
    }));
    return withOccupancy;
  }

  async updateSlot(slotId: string, dto: { name?: string; dimensions?: string; basePriceWeekly?: number; maxConcurrentAds?: number; isActive?: boolean }) {
    const slot = await this.prisma.adSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new NotFoundException('المساحة الإعلانية غير موجودة');
    if (dto.maxConcurrentAds != null && dto.maxConcurrentAds > 5) {
      throw new BadRequestException('الحد الأقصى للإعلانات المتزامنة في مساحة واحدة هو 5 (عرض شرائحي)');
    }
    return this.prisma.adSlot.update({
      where: { id: slotId },
      data: {
        name: dto.name, dimensions: dto.dimensions,
        basePriceWeekly: dto.basePriceWeekly != null ? Number(dto.basePriceWeekly) : undefined,
        maxConcurrentAds: dto.maxConcurrentAds != null ? Number(dto.maxConcurrentAds) : undefined,
        isActive: dto.isActive,
      },
    });
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
    slotId: string; targetSector?: string; targetZone?: string; targetUserType?: string;
    dailyStartHour?: number; dailyEndHour?: number; frequencyCap?: number;
    bannerUrl: string; destinationUrl: string;
    startDate: string; billingPeriod: string;
  }) {
    const start = new Date(dto.startDate);
    if (isNaN(start.getTime())) {
      throw new BadRequestException('تاريخ البدء غير صحيح');
    }
    const periodDays = BILLING_PERIOD_DAYS[dto.billingPeriod];
    if (!periodDays) {
      throw new BadRequestException('مدة الحجز غير معروفة');
    }
    // endDate is always derived from the period, never trusted from the
    // client — otherwise a WEEKLY-priced booking could send an arbitrary
    // endDate and occupy the slot far longer than the week it paid for.
    const end = new Date(start.getTime() + periodDays * 86400000);

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
        advertiserId, slotId: dto.slotId,
        targetSector: dto.targetSector, targetZone: dto.targetZone, targetUserType: dto.targetUserType,
        dailyStartHour: dto.dailyStartHour, dailyEndHour: dto.dailyEndHour, frequencyCap: dto.frequencyCap,
        bannerUrl: dto.bannerUrl, destinationUrl: dto.destinationUrl,
        startDate: start, endDate: end, billingPeriod: dto.billingPeriod,
        totalPrice, paymentStatus: 'UNPAID', reviewStatus: 'PENDING_REVIEW',
      },
    });

    this.logger.log(`Ad booking created: ${booking.id} (${slot.name}, ${totalPrice} EGP)`);
    return booking;
  }

  // ── ADMIN: grant a free/complimentary ad booking (bypasses payment) ──
  async createGiftBooking(dto: {
    advertiserId: string; slotId: string; targetSector?: string; targetZone?: string; targetUserType?: string;
    bannerUrl: string; destinationUrl: string; startDate: string; billingPeriod: string; note?: string;
  }) {
    const start = new Date(dto.startDate);
    if (isNaN(start.getTime())) throw new BadRequestException('تاريخ البدء غير صحيح');
    const periodDays = BILLING_PERIOD_DAYS[dto.billingPeriod];
    if (!periodDays) throw new BadRequestException('مدة الحجز غير معروفة');
    const end = new Date(start.getTime() + periodDays * 86400000);

    if (!dto.bannerUrl || !dto.destinationUrl) {
      throw new BadRequestException('ملف الإعلان ورابط الهبوط مطلوبان');
    }

    const { available, slot } = await this.checkAvailability(dto.slotId, start, end);
    if (!available) {
      throw new BadRequestException('هذه المساحة محجوزة بالكامل في الفترة المطلوبة — جربي فترة أو مساحة أخرى');
    }

    const booking = await this.prisma.adBooking.create({
      data: {
        advertiserId: dto.advertiserId, slotId: dto.slotId,
        targetSector: dto.targetSector, targetZone: dto.targetZone, targetUserType: dto.targetUserType,
        bannerUrl: dto.bannerUrl, destinationUrl: dto.destinationUrl,
        startDate: start, endDate: end, billingPeriod: dto.billingPeriod,
        totalPrice: 0, paymentStatus: 'WAIVED', reviewStatus: 'APPROVED',
        adminNote: dto.note ? `هدية من الإدارة: ${dto.note}` : 'هدية من الإدارة',
      },
    });

    this.logger.log(`Gift ad booking created by admin: ${booking.id} (${slot.name}, free)`);
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
  // Compound targeting (zone + sector + account type), dayparting, and
  // A/B variant selection all happen here. Returns { ads: [...],
  // adsenseFallback: {...} | null } — the client injects AdSense only
  // when ads is empty AND the slot has fallback enabled.
  async getActiveForSlot(locationKey: string, ctx: { sector?: string; zone?: string; userType?: string }) {
    const now = new Date();
    const slot = await this.prisma.adSlot.findUnique({ where: { locationKey: locationKey as any } });
    if (!slot) return { ads: [], adsenseFallback: null };

    let bookings = await this.prisma.adBooking.findMany({
      where: {
        slotId: slot.id, reviewStatus: 'APPROVED', paymentStatus: 'PAID', suspended: false,
        startDate: { lte: now }, endDate: { gte: now },
      },
      include: {
        advertiser: { select: { nameAr: true, trustScore: true, avgRating: true } },
        variants: true,
      },
    });

    // Compound targeting: null on a booking's field = "any", matches everyone.
    bookings = bookings.filter(b => {
      if (b.targetSector && ctx.sector && b.targetSector !== ctx.sector) return false;
      if (b.targetSector && !ctx.sector) return false;
      if (b.targetZone && ctx.zone && b.targetZone !== ctx.zone) return false;
      if (b.targetZone && !ctx.zone) return false;
      if (b.targetUserType && ctx.userType && b.targetUserType !== ctx.userType) return false;
      if (b.targetUserType && !ctx.userType) return false;
      return true;
    });

    // Dayparting: both hours set on a booking means "only serve within this window".
    const hour = now.getHours();
    bookings = bookings.filter(b => {
      if (b.dailyStartHour == null || b.dailyEndHour == null) return true;
      return hour >= b.dailyStartHour && hour <= b.dailyEndHour;
    });

    const ads = bookings.slice(0, slot.maxConcurrentAds).map(b => {
      const creative = this.pickVariant(b);
      return {
        campaignId: b.id,
        variantId: creative.variantId,
        bannerUrl: creative.bannerUrl,
        destinationUrl: creative.destinationUrl,
        advertiserName: b.advertiser?.nameAr,
        frequencyCap: b.frequencyCap,
      };
    });

    return {
      ads,
      adsenseFallback: (ads.length === 0 && slot.adsenseFallbackEnabled)
        ? { clientId: slot.adsenseClientId, slotId: slot.adsenseSlotId, dimensions: slot.dimensions }
        : null,
    };
  }

  // Weighted A/B pick. No variants -> serve the booking's own creative
  // (backward-compatible default). variantId is null in that case so
  // impression/click tracking knows to hit the booking's own counters.
  private pickVariant(booking: any): { variantId: string | null; bannerUrl: string; destinationUrl: string } {
    if (!booking.variants || booking.variants.length === 0) {
      return { variantId: null, bannerUrl: booking.bannerUrl, destinationUrl: booking.destinationUrl };
    }
    const roll = Math.random() * 100;
    let cumulative = 0;
    for (const v of booking.variants) {
      cumulative += v.weightPct;
      if (roll <= cumulative) return { variantId: v.id, bannerUrl: v.bannerUrl, destinationUrl: v.destinationUrl };
    }
    const last = booking.variants[booking.variants.length - 1];
    return { variantId: last.id, bannerUrl: last.bannerUrl, destinationUrl: last.destinationUrl };
  }

  // ── TRACKING (with basic per-day de-dup fraud guard + anomaly detection) ──
  async recordImpression(campaignId: string, ip: string, variantId?: string) {
    if (alreadySeen(`imp:${campaignId}:${ip}`, 60_000)) return; // 1/min/IP cap
    const today = new Date(); today.setHours(0, 0, 0, 0);
    await this.prisma.adMetric.upsert({
      where: { campaignId_date: { campaignId, date: today } },
      create: { campaignId, date: today, impressions: 1, clicks: 0 },
      update: { impressions: { increment: 1 } },
    }).catch(() => { /* campaign may not exist anymore — ignore */ });

    if (variantId) {
      await this.prisma.adVariant.update({
        where: { id: variantId }, data: { impressions: { increment: 1 } },
      }).catch(() => {});
    }

    await this.checkAnomalies(campaignId);
  }

  async recordClick(campaignId: string, ip: string, variantId?: string): Promise<string> {
    const booking = await this.prisma.adBooking.findUnique({ where: { id: campaignId }, include: { variants: true } });
    if (!booking) throw new NotFoundException('الإعلان غير موجود');

    if (!alreadySeen(`clk:${campaignId}:${ip}`, 10_000)) { // 1/10s/IP cap
      const today = new Date(); today.setHours(0, 0, 0, 0);
      await this.prisma.adMetric.upsert({
        where: { campaignId_date: { campaignId, date: today } },
        create: { campaignId, date: today, impressions: 0, clicks: 1 },
        update: { clicks: { increment: 1 } },
      });
      if (variantId) {
        await this.prisma.adVariant.update({
          where: { id: variantId }, data: { clicks: { increment: 1 } },
        }).catch(() => {});
      }
    }

    await this.checkAnomalies(campaignId);

    if (variantId) {
      const variant = booking.variants.find(v => v.id === variantId);
      if (variant) return variant.destinationUrl;
    }
    return booking.destinationUrl;
  }

  // Real-time anomaly detection, run after every impression/click so
  // alerts fire as soon as thresholds are crossed rather than on a delay.
  private async checkAnomalies(bookingId: string) {
    const agg = await this.prisma.adMetric.aggregate({
      where: { campaignId: bookingId }, _sum: { impressions: true, clicks: true },
    });
    const impressions = agg._sum.impressions || 0;
    const clicks = agg._sum.clicks || 0;
    if (impressions === 0) return;
    const ctr = (clicks / impressions) * 100;

    if (impressions >= SPIKE_MIN_IMPRESSIONS && ctr > SPIKE_CTR_THRESHOLD) {
      const already = await this.prisma.adAlert.findFirst({
        where: { bookingId, type: 'SPIKE', resolved: false },
      });
      if (!already) {
        await this.prisma.adBooking.update({
          where: { id: bookingId },
          data: { suspended: true, suspendedReason: 'إيقاف تلقائي — نشاط نقر مريب (CTR غير طبيعي)' },
        });
        const message = `⚠️ نشاط نقر مريب على إعلان ${bookingId} — CTR وصل ${ctr.toFixed(1)}% (${clicks}/${impressions}). تم إيقاف الإعلان تلقائيًا لحين المراجعة.`;
        await this.prisma.adAlert.create({ data: { bookingId, type: 'SPIKE', message } });
        this.logger.warn(message);
        await dispatchAlertWebhook(message);
      }
    }

    if (impressions >= UNDERPERFORM_MIN_IMPRESSIONS && ctr < UNDERPERFORM_CTR_THRESHOLD) {
      const already = await this.prisma.adAlert.findFirst({
        where: { bookingId, type: 'UNDERPERFORMING', resolved: false },
      });
      if (!already) {
        const message = `📉 إعلان ${bookingId} أداؤه ضعيف — CTR ${ctr.toFixed(2)}% بعد ${impressions} ظهور. يستحق مراجعة التصميم أو النص.`;
        await this.prisma.adAlert.create({ data: { bookingId, type: 'UNDERPERFORMING', message } });
        this.logger.log(message);
        await dispatchAlertWebhook(message);
      }
    }
  }

  // ── ALERTS (admin) ────────────────────────────────────────────
  async listAlerts(onlyUnresolved = true) {
    return this.prisma.adAlert.findMany({
      where: onlyUnresolved ? { resolved: false } : undefined,
      include: { booking: { include: { slot: true, advertiser: { select: { nameAr: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolveAlert(id: string) {
    const alert = await this.prisma.adAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('التنبيه غير موجود');
    return this.prisma.adAlert.update({ where: { id }, data: { resolved: true } });
  }

  async adminResume(id: string) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    return this.prisma.adBooking.update({ where: { id }, data: { suspended: false, suspendedReason: null } });
  }

  // ── A/B VARIANTS ───────────────────────────────────────────────
  async addVariant(bookingId: string, dto: { label: string; bannerUrl: string; destinationUrl: string; weightPct?: number }) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    return this.prisma.adVariant.create({
      data: {
        bookingId, label: dto.label, bannerUrl: dto.bannerUrl,
        destinationUrl: dto.destinationUrl, weightPct: dto.weightPct || 50,
      },
    });
  }

  async listVariants(bookingId: string) {
    return this.prisma.adVariant.findMany({ where: { bookingId }, orderBy: { label: 'asc' } });
  }

  // ── ADMIN: AdSense fallback toggle (per slot) ────────────────────
  async adminSetAdsenseFallback(slotId: string, enabled: boolean, clientId?: string, googleSlotId?: string) {
    const slot = await this.prisma.adSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new NotFoundException('المساحة غير موجودة');
    return this.prisma.adSlot.update({
      where: { id: slotId },
      data: { adsenseFallbackEnabled: enabled, adsenseClientId: clientId, adsenseSlotId: googleSlotId },
    });
  }

  // ── ADMIN: direct override (budget/date/pause with reason) ──────
  async adminOverride(id: string, dto: { startDate?: string; endDate?: string; totalPrice?: number; suspend?: boolean; reason?: string }) {
    const booking = await this.prisma.adBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    const data: any = {};
    if (dto.startDate) data.startDate = new Date(dto.startDate);
    if (dto.endDate) data.endDate = new Date(dto.endDate);
    if (dto.totalPrice !== undefined) data.totalPrice = dto.totalPrice;
    if (dto.suspend !== undefined) {
      data.suspended = dto.suspend;
      data.suspendedReason = dto.suspend ? (dto.reason || 'إيقاف يدوي من الإدارة') : null;
    }
    return this.prisma.adBooking.update({ where: { id }, data });
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
@Controller('promo-placements')
export class AdsV2Controller {
  constructor(private ads: AdsV2Service, private admin: AdminService) {}

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
  @ApiOperation({ summary: 'الإعلانات النشطة حاليًا لمساحة معينة (للحقن في الصفحة) — مع استهداف مركّب' })
  serve(
    @Param('locationKey') locationKey: string,
    @Query('sector') sector: string,
    @Query('zone') zone: string,
    @Query('userType') userType: string,
  ) {
    return this.ads.getActiveForSlot(locationKey, { sector, zone, userType });
  }

  @Post('impression/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'تسجيل ظهور إعلان' })
  async impression(@Param('id') id: string, @Query('variant') variantId: string, @Req() req: any) {
    await this.ads.recordImpression(id, req.ip || 'unknown', variantId);
  }

  @Get('click/:id')
  @ApiOperation({ summary: 'تسجيل نقرة والتحويل لرابط الإعلان' })
  async click(@Param('id') id: string, @Query('variant') variantId: string, @Req() req: any, @Res() res: any) {
    const url = await this.ads.recordClick(id, req.ip || 'unknown', variantId);
    res.redirect(url);
  }

  // Advertiser (authenticated company)
  @Post('upload-banner')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('banner', {
    storage: diskStorage({
      destination: join(process.cwd(), 'uploads', 'ad-banners'),
      filename: (req: any, file, cb) => {
        const companyId = req.user?.companyId || 'unknown';
        const ext = extname(file.originalname) || '.png';
        cb(null, `${companyId}-${Date.now()}${ext}`);
      },
    }),
    fileFilter: (req, file, cb) => {
      if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) {
        return cb(new BadRequestException('الملف لازم يكون صورة PNG أو JPG أو WEBP'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  }))
  @ApiOperation({ summary: 'رفع صورة الإعلان (بانر)' })
  uploadBanner(@UploadedFile() file: any, @Request() req: any) {
    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    if (!req.user.companyId && !isAdmin) throw new ForbiddenException('يجب تسجيل حساب شركة أولاً');
    if (!file) throw new BadRequestException('لم يتم إرفاق أي ملف');
    return { bannerUrl: `/uploads/ad-banners/${file.filename}` };
  }

  @Post('bookings')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حجز مساحة إعلانية جديدة' })
  createBooking(@Body() dto: any, @Request() req: any) {
    return this.ads.createBooking(req.user.companyId, dto);
  }

  @Post('admin/gift-booking')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'منح إعلان مجاني/هدية لشركة (أدمن فقط)' })
  createGiftBooking(@Body() dto: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.createGiftBooking(dto);
  }

  @Post('admin/paid-booking')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة حجز إعلان مدفوع نيابةً عن شركة (أدمن) — يدعم شركة غير مسجّلة' })
  async createPaidBookingAsAdmin(@Body() dto: any, @Request() req: any) {
    this.requireAdmin(req);
    let advertiserId = dto.advertiserId;
    if (dto.createExternalCompany) {
      const company = await this.admin.createExternalCompany(
        dto.createExternalCompany.nameAr,
        dto.createExternalCompany.type || 'SUPPLIER',
      );
      advertiserId = company.id;
    }
    if (!advertiserId) throw new BadRequestException('يجب تحديد الشركة أو بيانات شركة جديدة');
    return this.ads.createBooking(advertiserId, dto);
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

  @Post('admin/:id/resume')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'استئناف إعلان مُوقَف تلقائيًا بعد المراجعة (أدمن)' })
  adminResume(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.adminResume(id);
  }

  @Patch('admin/:id/override')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل مباشر على تواريخ/ميزانية/إيقاف حجز (أدمن)' })
  adminOverride(
    @Param('id') id: string,
    @Body() body: { startDate?: string; endDate?: string; totalPrice?: number; suspend?: boolean; reason?: string },
    @Request() req: any,
  ) {
    this.requireAdmin(req);
    return this.ads.adminOverride(id, body);
  }

  // ── Real-time alerts (spike / underperforming) ───────────────────
  @Get('admin/alerts')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'التنبيهات اللحظية غير المحلولة (أدمن)' })
  listAlerts(@Query('all') all: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.listAlerts(all !== 'true');
  }

  @Post('admin/alerts/:id/resolve')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعليم تنبيه كمُعالَج (أدمن)' })
  resolveAlert(@Param('id') id: string, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.resolveAlert(id);
  }

  // ── A/B creative variants ────────────────────────────────────────
  @Post('bookings/:id/variants')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة نسخة إعلانية لاختبار A/B' })
  addVariant(@Param('id') id: string, @Body() dto: { label: string; bannerUrl: string; destinationUrl: string; weightPct?: number }) {
    return this.ads.addVariant(id, dto);
  }

  @Get('bookings/:id/variants')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'نسخ اختبار A/B لحجز معين' })
  listVariants(@Param('id') id: string) {
    return this.ads.listVariants(id);
  }

  // ── AdSense fallback toggle (per slot, admin) ────────────────────
  @Patch('admin/slots/:slotId')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل إعدادات مساحة إعلانية (الاسم، السعر، الحد الأقصى للإعلانات المتزامنة، إلخ) — أدمن' })
  updateSlot(@Param('slotId') slotId: string, @Body() dto: any, @Request() req: any) {
    this.requireAdmin(req);
    return this.ads.updateSlot(slotId, dto);
  }

  @Patch('admin/slots/:slotId/adsense')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تفعيل/تعطيل AdSense الاحتياطي لمساحة (أدمن)' })
  setAdsenseFallback(
    @Param('slotId') slotId: string,
    @Body() body: { enabled: boolean; clientId?: string; googleSlotId?: string },
    @Request() req: any,
  ) {
    this.requireAdmin(req);
    return this.ads.adminSetAdsenseFallback(slotId, !!body.enabled, body.clientId, body.googleSlotId);
  }
}
