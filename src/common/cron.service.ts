// ─── cron/cron.service.ts ─────────────────────────────────────────
// Scheduled tasks: auto-release escrow, expire RFQs, subscription renewal
// Uses @nestjs/schedule + node-cron

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
    private scheduler:     SchedulerRegistry,
  ) {}

  // ── EVERY 30 MINUTES: Auto-release expired escrows ────────────
  @Cron('*/30 * * * *', { name: 'auto-release-escrow' })
  async autoReleaseEscrows() {
    const expired = await this.prisma.escrow.findMany({
      where: {
        status:       'HELD',
        autoReleaseAt: { lte: new Date() },
      },
      include: { order: true },
      take: 50,
    });

    if (expired.length === 0) return;
    this.logger.log(`Auto-releasing ${expired.length} escrows...`);

    for (const escrow of expired) {
      try {
        await this.prisma.$transaction([
          this.prisma.escrow.update({
            where: { id: escrow.id },
            data: {
              status:      'RELEASED',
              releasedAt:  new Date(),
              transactions: {
                create: {
                  type:      'AUTO_RELEASE',
                  amount:    escrow.netToSupplier,
                  reference: `AUTO-${Date.now()}`,
                  metadata:  { reason: 'Buyer did not respond within 72 hours' },
                },
              },
            },
          }),
          this.prisma.order.update({
            where: { id: escrow.orderId },
            data: {
              status:      'CONFIRMED',
              confirmedAt: new Date(),
            },
          }),
        ]);

        // Notify both parties
        const [buyerUser, supplierUser] = await Promise.all([
          this.prisma.user.findFirst({ where: { company: { id: escrow.order.buyerCompanyId } } }),
          this.prisma.user.findFirst({ where: { company: { id: escrow.order.supplierCompanyId } } }),
        ]);

        if (supplierUser) {
          await this.notifications.send(
            supplierUser.id, 'ESCROW_RELEASED',
            'تم الإفراج التلقائي عن أموالك',
            `لم يؤكد المشتري أو يرفض خلال ٧٢ ساعة — تم الإفراج التلقائي عن ${escrow.netToSupplier.toLocaleString()} ج.م`,
            { orderId: escrow.orderId },
          );
        }
        if (buyerUser) {
          await this.notifications.send(
            buyerUser.id, 'SYSTEM',
            'انتهت مهلة تأكيد الاستلام',
            'تم الإفراج التلقائي عن المبلغ للمورد لعدم ردك خلال ٧٢ ساعة. للاعتراض يرجى تواصل مع الدعم.',
            { orderId: escrow.orderId },
          );
        }

        this.logger.log(`Auto-released escrow ${escrow.id} for order ${escrow.orderId}`);
      } catch (err) {
        this.logger.error(`Failed to auto-release escrow ${escrow.id}`, err.message);
      }
    }
  }

  // ── EVERY HOUR: Expire published RFQs past deadline ──────────
  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-rfqs' })
  async expireRfqs() {
    const expired = await this.prisma.rfqRequest.updateMany({
      where: {
        status:     'PUBLISHED',
        expiresAt:  { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    if (expired.count > 0) {
      this.logger.log(`Expired ${expired.count} RFQ requests`);
    }
  }

  // ── EVERY HOUR: Send deadline reminders ──────────────────────
  @Cron(CronExpression.EVERY_HOUR, { name: 'rfq-reminders' })
  async sendRfqReminders() {
    // RFQs expiring in exactly 24 hours
    const expiringSoon = await this.prisma.rfqRequest.findMany({
      where: {
        status: 'PUBLISHED',
        expiresAt: {
          gte: new Date(Date.now() + 23 * 3600000),
          lte: new Date(Date.now() + 25 * 3600000),
        },
      },
      include: { buyer: { include: { user: true } } },
    });

    for (const rfq of expiringSoon) {
      if (rfq.buyer?.user) {
        await this.notifications.send(
          rfq.buyer.user.id, 'RFQ_EXPIRED',
          'طلب RFQ ينتهي خلال ٢٤ ساعة',
          `طلبك #${rfq.id.slice(-6).toUpperCase()} ينتهي خلال ٢٤ ساعة. راجع العروض المستلمة الآن.`,
          { rfqId: rfq.id },
        );
      }
    }
  }

  // ── DAILY 2AM: Recalculate Trust Scores ──────────────────────
  @Cron('0 2 * * *', { name: 'trust-score-recalc' })
  async recalculateTrustScores() {
    this.logger.log('Starting daily Trust Score recalculation...');

    const suppliers = await this.prisma.company.findMany({
      where: { type: 'SUPPLIER' },
      select: { id: true },
    });

    let updated = 0;
    for (const { id } of suppliers) {
      try {
        const orders = await this.prisma.order.findMany({
          where: { supplierCompanyId: id, status: { in: ['CONFIRMED', 'DISPUTED'] } },
          include: { review: true },
        });

        if (!orders.length) continue;

        const reviews  = orders.filter(o => o.review).map(o => o.review!);
        const disputed = orders.filter(o => o.status === 'DISPUTED').length;

        const avgSpec = reviews.length ? reviews.reduce((a, r) => a + r.qualityScore, 0) / reviews.length : 75;
        const avgTime = reviews.length ? reviews.reduce((a, r) => a + r.timeScore, 0) / reviews.length : 75;
        const avgComm = reviews.length ? reviews.reduce((a, r) => a + r.commScore, 0) / reviews.length : 75;
        const noDisputeScore = Math.max(0, 100 - (disputed / orders.length) * 1000);

        const score = Math.min(100, Math.round(
          avgSpec * 20 * 0.4 +
          avgTime * 20 * 0.3 +
          avgComm * 20 * 0.2 +
          noDisputeScore   * 0.1,
        ));

        await this.prisma.company.update({
          where: { id },
          data: {
            trustScore:      score,
            specMatchRate:   avgSpec,
            onTimeRate:      avgTime,
            avgRating:       reviews.length
              ? reviews.reduce((a, r) => a + r.overallScore, 0) / reviews.length
              : 0,
            totalReviews:    reviews.length,
            totalDeals:      orders.filter(o => o.status === 'CONFIRMED').length,
          },
        });
        updated++;
      } catch (err) {
        this.logger.error(`Trust score failed for ${id}`, err.message);
      }
    }

    this.logger.log(`Trust Score recalc complete: ${updated}/${suppliers.length} suppliers updated`);
  }

  // ── DAILY 3AM: Loyalty Points Tier Upgrades ──────────────────
  @Cron('0 3 * * *', { name: 'loyalty-tier-upgrade' })
  async upgradeLoyaltyTiers() {
    const TIERS = [
      { name: 'PLATINUM', minPoints: 10000 },
      { name: 'GOLD',     minPoints: 5000  },
      { name: 'SILVER',   minPoints: 1000  },
      { name: 'BRONZE',   minPoints: 0     },
    ];

    const loyalties = await this.prisma.loyaltyPoints.findMany();
    let upgraded = 0;

    for (const lp of loyalties) {
      const newTier = TIERS.find(t => lp.points >= t.minPoints)?.name || 'BRONZE';
      if (newTier !== lp.tier) {
        await this.prisma.loyaltyPoints.update({
          where: { id: lp.id },
          data: { tier: newTier },
        });

        const user = await this.prisma.user.findFirst({
          where: { company: { id: lp.companyId } },
        });
        if (user) {
          await this.notifications.send(
            user.id, 'SYSTEM',
            `ترقية مستوى الولاء إلى ${newTier}`,
            `مبروك! تمت ترقيتك إلى مستوى ${newTier}. استمتع بمزايا إضافية على طلباتك القادمة.`,
          );
        }
        upgraded++;
      }
    }

    if (upgraded > 0) this.logger.log(`Loyalty tiers upgraded: ${upgraded}`);
  }

  // ── WEEKLY SUNDAY 4AM: Subscription Auto-Renewal ─────────────
  @Cron('0 4 * * 0', { name: 'subscription-renewal' })
  async renewSubscriptions() {
    const expiringSoon = await this.prisma.subscription.findMany({
      where: {
        autoRenew:  true,
        plan:       { not: 'FREE' },
        endDate:    {
          gte: new Date(),
          lte: new Date(Date.now() + 7 * 86400000),
        },
      },
      include: { company: { include: { user: true } } },
    });

    this.logger.log(`Processing ${expiringSoon.length} subscription renewals...`);

    for (const sub of expiringSoon) {
      try {
        // Extend by 30 days
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { endDate: new Date(sub.endDate!.getTime() + 30 * 86400000) },
        });

        if (sub.company?.user) {
          await this.notifications.send(
            sub.company.user.id, 'SYSTEM',
            'تم تجديد اشتراكك',
            `تم تجديد اشتراكك تلقائياً حتى ${new Date(sub.endDate!.getTime() + 30 * 86400000).toLocaleDateString('ar-EG')}`,
          );
        }
      } catch (err) {
        this.logger.error(`Subscription renewal failed: ${sub.id}`, err.message);
      }
    }
  }

  // ── DAILY 1AM: Clean expired OTP codes ───────────────────────
  @Cron('0 1 * * *', { name: 'clean-otps' })
  async cleanExpiredOtps() {
    const result = await this.prisma.otpCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: new Date() } },
          { isUsed: true, createdAt: { lte: new Date(Date.now() - 24 * 3600000) } },
        ],
      },
    });
    if (result.count > 0) this.logger.log(`Cleaned ${result.count} expired OTP codes`);
  }

  // ── DAILY 1:30AM: Clean expired refresh tokens ───────────────
  @Cron('30 1 * * *', { name: 'clean-tokens' })
  async cleanExpiredTokens() {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: new Date() } },
          { isRevoked: true, createdAt: { lte: new Date(Date.now() - 7 * 86400000) } },
        ],
      },
    });
    if (result.count > 0) this.logger.log(`Cleaned ${result.count} expired tokens`);
  }

  // ── EVERY 6 HOURS: Generate feasibility studies from market gaps
  @Cron('0 */6 * * *', { name: 'market-gaps-analysis' })
  async analyzeMarketGaps() {
    // Count unmet RFQs per category in last 90 days
    const gaps = await this.prisma.rfqRequest.groupBy({
      by: ['categoryId'],
      where: {
        status:    { in: ['EXPIRED', 'CANCELLED'] },
        createdAt: { gte: new Date(Date.now() - 90 * 86400000) },
      },
      _count: { id: true },
      having: { id: { _count: { gt: 5 } } }, // Only significant gaps
      orderBy: { _count: { id: 'desc' } },
    });

    if (gaps.length > 0) {
      this.logger.log(`Market gaps identified: ${gaps.length} sectors with unmet demand`);
      // In production: trigger AI analysis to generate new feasibility study drafts
    }
  }
}
