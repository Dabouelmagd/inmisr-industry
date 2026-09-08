// ─── loyalty/loyalty.service.ts ───────────────────────────────────
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const TIERS = [
  { name: 'PLATINUM', label: 'بلاتيني',  minPoints: 10000, badge: '💎', color: '#B9D4EF' },
  { name: 'GOLD',     label: 'ذهبي',     minPoints: 5000,  badge: '🥇', color: '#C09300' },
  { name: 'SILVER',   label: 'فضي',      minPoints: 1000,  badge: '🥈', color: '#9E9E9E' },
  { name: 'BRONZE',   label: 'برونزي',   minPoints: 0,     badge: '🥉', color: '#CD7F32' },
] as const;

const RECURRING_DISCOUNTS = [
  { minOrders: 20, discount: 0.15, label: '١٥٪ خصم (٢٠+ طلب)' },
  { minOrders: 10, discount: 0.10, label: '١٠٪ خصم (١٠+ طلبات)' },
  { minOrders: 3,  discount: 0.05, label: '٥٪ خصم (٣+ طلبات)' },
] as const;

const POINTS_PER_EGP    = 0.01;   // 1 point per 100 EGP
const POINTS_PER_REVIEW = 50;     // Bonus for leaving a review
const POINTS_FOR_VERIFY = 200;    // Bonus for completing verification

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ── AWARD POINTS after completed order ────────────────────────
  async awardOrderPoints(companyId: string, orderId: string, amount: number) {
    const points = Math.floor(amount * POINTS_PER_EGP);
    return this.addPoints(companyId, points, 'ORDER_COMPLETED', orderId,
      `صفقة مكتملة بقيمة ${amount.toLocaleString()} ج.م`);
  }

  // ── AWARD POINTS for review ───────────────────────────────────
  async awardReviewPoints(companyId: string, reviewId: string) {
    return this.addPoints(companyId, POINTS_PER_REVIEW, 'REVIEW_LEFT', reviewId, 'تقييم مكتمل');
  }

  // ── AWARD POINTS for verification ─────────────────────────────
  async awardVerificationPoints(companyId: string, level: string) {
    const pointsMap: Record<string, number> = {
      BASIC: POINTS_FOR_VERIFY, CERTIFIED: POINTS_FOR_VERIFY * 2, ELITE: POINTS_FOR_VERIFY * 5,
    };
    const pts = pointsMap[level] || POINTS_FOR_VERIFY;
    return this.addPoints(companyId, pts, 'VERIFICATION_COMPLETE', level,
      `حصلت على مستوى التحقق ${level}`);
  }

  // ── CORE: Add points + handle tier upgrade ────────────────────
  private async addPoints(
    companyId: string, points: number, reason: string,
    referenceId: string, description: string,
  ) {
    const prev = await this.prisma.loyaltyPoints.findUnique({ where: { companyId } });
    const currentPoints = (prev?.points || 0) + points;
    const currentTier   = prev?.tier || 'BRONZE';

    const tx = await this.prisma.loyaltyPoints.upsert({
      where:  { companyId },
      create: {
        companyId, points, totalEarned: points, totalRedeemed: 0,
        tier: 'BRONZE',
        transactionsJson: [{ reason, referenceId, points, description, at: new Date().toISOString() }],
      },
      update: {
        points:      { increment: points },
        totalEarned: { increment: points },
        lastUpdated: new Date(),
        transactionsJson: {
          push: { reason, referenceId, points, description, at: new Date().toISOString() },
        } as any,
      },
    });

    // Check tier upgrade
    const newTier = TIERS.find(t => currentPoints >= t.minPoints)?.name || 'BRONZE';
    if (newTier !== currentTier) {
      await this.prisma.loyaltyPoints.update({
        where: { companyId }, data: { tier: newTier },
      });
      const tierInfo = TIERS.find(t => t.name === newTier)!;
      const user = await this.prisma.user.findFirst({ where: { company: { id: companyId } } });
      if (user) {
        await this.notifications.send(user.id, 'SYSTEM',
          `ترقية إلى ${tierInfo.label} ${tierInfo.badge}`,
          `مبروك! وصلت إلى مستوى ${tierInfo.label}. استمتع بمزايا حصرية على طلباتك القادمة.`,
          { newTier, points: currentPoints },
        );
      }
      this.logger.log(`Loyalty tier upgrade: company ${companyId} → ${newTier}`);
    }

    return { points, totalPoints: currentPoints, tier: newTier, tierUpgraded: newTier !== currentTier };
  }

  // ── REDEEM POINTS ─────────────────────────────────────────────
  async redeemPoints(companyId: string, pointsToRedeem: number, orderId: string) {
    const loyalty = await this.prisma.loyaltyPoints.findUnique({ where: { companyId } });
    if (!loyalty || loyalty.points < pointsToRedeem) {
      throw new Error('نقاط غير كافية للاسترداد');
    }

    const discountEgp = Math.floor(pointsToRedeem / 10); // 10 points = 1 EGP discount

    await this.prisma.loyaltyPoints.update({
      where: { companyId },
      data: {
        points:        { decrement: pointsToRedeem },
        totalRedeemed: { increment: pointsToRedeem },
        transactionsJson: {
          push: {
            reason: 'POINTS_REDEEMED', referenceId: orderId,
            points: -pointsToRedeem,
            description: `استرداد ${pointsToRedeem} نقطة مقابل خصم ${discountEgp} ج.م`,
            at: new Date().toISOString(),
          },
        } as any,
      },
    });

    return { redeemedPoints: pointsToRedeem, discountEgp };
  }

  // ── CALCULATE RECURRING DISCOUNT ─────────────────────────────
  async getRecurringDiscount(buyerCompanyId: string, supplierCompanyId: string): Promise<{
    discountPct: number; label: string; orderCount: number;
  }> {
    const orderCount = await this.prisma.order.count({
      where: {
        buyerCompanyId, supplierCompanyId,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
      },
    });

    const tier = RECURRING_DISCOUNTS.find(d => orderCount >= d.minOrders);
    return {
      discountPct: tier?.discount || 0,
      label:       tier?.label   || 'لا يوجد خصم بعد',
      orderCount,
    };
  }

  // ── GET LOYALTY SUMMARY ───────────────────────────────────────
  async getSummary(companyId: string) {
    const loyalty = await this.prisma.loyaltyPoints.findUnique({ where: { companyId } });
    if (!loyalty) return { points: 0, tier: 'BRONZE', tierInfo: TIERS[3], nextTier: null };

    const currentTier = TIERS.find(t => t.name === loyalty.tier) || TIERS[3];
    const nextTier    = TIERS.find(t => t.minPoints > loyalty.points);
    const pointsToNext = nextTier ? nextTier.minPoints - loyalty.points : 0;

    return {
      points:         loyalty.points,
      totalEarned:    loyalty.totalEarned,
      totalRedeemed:  loyalty.totalRedeemed,
      tier:           loyalty.tier,
      tierInfo:       currentTier,
      nextTier,
      pointsToNext,
      progress:       nextTier ? Math.round((loyalty.points / nextTier.minPoints) * 100) : 100,
      egpEquivalent:  Math.floor(loyalty.points / 10),
      transactions:   (loyalty.transactionsJson as any[]).slice(-10).reverse(),
    };
  }

  getTiers() { return TIERS; }
  getDiscountTiers() { return RECURRING_DISCOUNTS; }
}
