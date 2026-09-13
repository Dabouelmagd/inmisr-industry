// ─── admin/admin.service.ts ───────────────────────────────────────
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoiceService } from '../finance/invoice.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
    private invoice:       InvoiceService,
  ) {}

  // ── DISPUTE MANAGEMENT ────────────────────────────────────────
  async getDisputes(filter: { status?: string; page?: number; limit?: number }) {
    const where: any = {};
    if (filter.status) where.status = filter.status;

    const [data, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        include: {
          order: {
            include: {
              buyer:    { select: { nameAr: true } },
              supplier: { select: { nameAr: true } },
              escrow:   { select: { amount: true, status: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: ((filter.page || 1) - 1) * (filter.limit || 20),
        take: filter.limit || 20,
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return { data, total, page: filter.page || 1 };
  }

  // ── VERIFICATION QUEUE ────────────────────────────────────────
  async getVerifications(filter: { status?: string; page?: number; limit?: number }) {
    const where: any = { status: filter.status || 'PENDING' };

    const [data, total] = await Promise.all([
      this.prisma.verification.findMany({
        where,
        include: {
          company: { select: { nameAr: true, nameEn: true, type: true, commercialRegNo: true, taxId: true } },
        },
        orderBy: { createdAt: 'asc' },
        skip: ((filter.page || 1) - 1) * (filter.limit || 20),
        take: filter.limit || 20,
      }),
      this.prisma.verification.count({ where }),
    ]);

    return { data, total, page: filter.page || 1 };
  }

  async resolveDispute(disputeId: string, adminId: string, dto: {
    resolution:    string;
    winner:        'BUYER' | 'SUPPLIER' | 'SPLIT';
    splitPct?:     number; // % to buyer if SPLIT
  }) {
    const dispute = await this.prisma.dispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: { order: { include: { escrow: true, buyer: { include: { user: true } }, supplier: { include: { user: true } } } } },
    });

    if (!['OPEN', 'UNDER_REVIEW'].includes(dispute.status)) {
      throw new ForbiddenException('النزاع محلول بالفعل');
    }

    const escrow = dispute.order.escrow!;
    const amount = escrow.amount;
    let buyerAmount = 0, supplierAmount = 0;

    if (dto.winner === 'BUYER') {
      buyerAmount = amount;
    } else if (dto.winner === 'SUPPLIER') {
      supplierAmount = escrow.netToSupplier;
    } else {
      const pct = (dto.splitPct || 50) / 100;
      buyerAmount    = Math.round(amount * pct);
      supplierAmount = Math.round(amount * (1 - pct) * 0.975); // platform commission on supplier portion
    }

    await this.prisma.$transaction([
      this.prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status:     dto.winner === 'BUYER' ? 'RESOLVED_BUYER' : dto.winner === 'SUPPLIER' ? 'RESOLVED_SUPPLIER' : 'RESOLVED_BUYER',
          resolution: dto.resolution,
          resolvedBy: adminId,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.escrow.update({
        where: { orderId: dispute.orderId },
        data: {
          status:     'RELEASED',
          releasedAt: new Date(),
          transactions: {
            create: {
              type:      'DISPUTE_RESOLUTION',
              amount:    supplierAmount,
              reference: `DISPUTE-${disputeId.slice(-8)}`,
              metadata: { winner: dto.winner, buyerAmount, supplierAmount, resolution: dto.resolution },
            },
          },
        },
      }),
      this.prisma.order.update({
        where: { id: dispute.orderId },
        data: { status: 'CONFIRMED' },
      }),
    ]);

    // Notify both parties
    const buyerUser    = dispute.order.buyer?.user;
    const supplierUser = dispute.order.supplier?.user;

    if (buyerUser) {
      await this.notifications.send(buyerUser.id, 'SYSTEM',
        'تم حل النزاع',
        `قررت لجنة التحكيم: ${dto.resolution}. ${buyerAmount > 0 ? `سيصلك ${buyerAmount.toLocaleString()} ج.م` : 'لن يُسترد المبلغ في هذه الحالة.'}`,
        { disputeId, amount: buyerAmount },
      );
    }
    if (supplierUser) {
      await this.notifications.send(supplierUser.id, 'SYSTEM',
        'تم حل النزاع',
        `قررت لجنة التحكيم: ${dto.resolution}. ${supplierAmount > 0 ? `سيصلك ${supplierAmount.toLocaleString()} ج.م خلال ٢٤ ساعة.` : ''}`,
        { disputeId, amount: supplierAmount },
      );
    }

    return { resolved: true, winner: dto.winner, buyerAmount, supplierAmount };
  }

  // ── VERIFICATION REVIEW ───────────────────────────────────────
  async reviewVerification(verificationId: string, adminId: string, dto: {
    approved: boolean; notes?: string;
  }) {
    const verif = await this.prisma.verification.findUniqueOrThrow({
      where: { id: verificationId },
      include: { company: { include: { user: true } } },
    });

    await this.prisma.verification.update({
      where: { id: verificationId },
      data: {
        status:      dto.approved ? 'VERIFIED' : 'REJECTED',
        reviewerId:  adminId,
        reviewNotes: dto.notes,
        reviewedAt:  new Date(),
      },
    });

    if (verif.company?.user) {
      await this.notifications.send(verif.company.user.id, dto.approved ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED',
        dto.approved ? 'تم قبول وثيقتك' : 'تم رفض وثيقتك',
        dto.approved
          ? 'تم التحقق من وثيقتك بنجاح. تقدّمت خطوة نحو مستوى أعلى من التحقق.'
          : `تم رفض الوثيقة. السبب: ${dto.notes || 'الوثيقة غير واضحة أو غير صالحة'}. يرجى رفع وثيقة جديدة.`,
        { verificationId },
      );
    }

    return { reviewed: true, approved: dto.approved };
  }

  // ── PLATFORM DASHBOARD STATS ─────────────────────────────────
  // ── ESCROW STATS ─────────────────────────────────────────────
  async getEscrowStats() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [held, releasedMonth, disputed] = await Promise.all([
      this.prisma.escrow.aggregate({ where: { status: 'HELD' }, _sum: { amount: true }, _count: true }),
      this.prisma.escrow.aggregate({
        where: { status: 'RELEASED', releasedAt: { gte: monthStart } },
        _sum: { amount: true }, _count: true,
      }),
      this.prisma.escrow.count({ where: { status: { in: ['DISPUTED', 'ARBITRATION'] } } }),
    ]);

    return {
      held: { amount: held._sum.amount || 0, count: held._count },
      releasedThisMonth: { amount: releasedMonth._sum.amount || 0, count: releasedMonth._count },
      disputed,
    };
  }

  // ── ORDERS: platform-wide list (owner dashboard "الطلبات") ────────
  async adminListOrders(filter: { status?: string; page?: number; limit?: number }) {
    const where: any = {};
    if (filter.status) where.status = filter.status;

    const page = filter.page || 1;
    const limit = filter.limit || 20;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          buyer: { select: { nameAr: true } },
          supplier: { select: { nameAr: true } },
          escrow: { select: { status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async adminGetOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        buyer: { select: { nameAr: true, nameEn: true } },
        supplier: { select: { nameAr: true, nameEn: true } },
        escrow: true,
        rfq: { select: { specsJson: true, quantity: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    return order;
  }

  // ── REVENUE BREAKDOWN (owner dashboard "الإيرادات") ───────────────
  async getRevenueBreakdown() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const COMPLETED_STATUSES = ['COMPLETED', 'CONFIRMED', 'DELIVERED'] as any[];

    const [commissionThis, commissionPrev, adsThis, adsPrev, growthCount, eliteCount] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: { in: COMPLETED_STATUSES }, createdAt: { gte: monthStart } },
        _sum: { commission: true },
      }),
      this.prisma.order.aggregate({
        where: { status: { in: COMPLETED_STATUSES }, createdAt: { gte: prevMonthStart, lt: monthStart } },
        _sum: { commission: true },
      }),
      this.prisma.adBooking.aggregate({
        where: { paymentStatus: 'PAID', createdAt: { gte: monthStart } },
        _sum: { totalPrice: true },
      }),
      this.prisma.adBooking.aggregate({
        where: { paymentStatus: 'PAID', createdAt: { gte: prevMonthStart, lt: monthStart } },
        _sum: { totalPrice: true },
      }),
      this.prisma.subscription.count({ where: { plan: 'GROWTH', OR: [{ endDate: null }, { endDate: { gte: now } }] } }),
      this.prisma.subscription.count({ where: { plan: 'ELITE', OR: [{ endDate: null }, { endDate: { gte: now } }] } }),
    ]);

    const pctGrowth = (curr: number, prev: number) => (prev > 0 ? +(((curr - prev) / prev) * 100).toFixed(1) : (curr > 0 ? 100 : 0));
    // Subscription prices are fixed platform-wide (per the pricing PRD) but
    // no per-payment amount is stored on Subscription -- this row is an
    // estimate from currently-active paid subscriptions × their known
    // price, not a literal transaction ledger like the other two rows.
    const subscriptionsEstimate = growthCount * 1500 + eliteCount * 4500;

    return {
      sources: [
        {
          key: 'commissions', label: 'عمولات صفقات',
          thisMonth: commissionThis._sum.commission || 0,
          lastMonth: commissionPrev._sum.commission || 0,
          growthPct: pctGrowth(commissionThis._sum.commission || 0, commissionPrev._sum.commission || 0),
        },
        {
          key: 'ads', label: 'إعلانات',
          thisMonth: adsThis._sum.totalPrice || 0,
          lastMonth: adsPrev._sum.totalPrice || 0,
          growthPct: pctGrowth(adsThis._sum.totalPrice || 0, adsPrev._sum.totalPrice || 0),
        },
        {
          key: 'subscriptions', label: 'اشتراكات (تقديري)',
          thisMonth: subscriptionsEstimate, lastMonth: null, growthPct: null,
          note: `${growthCount} Growth + ${eliteCount} Elite نشطة حاليًا`,
        },
      ],
    };
  }

  async getDashboardStats() {
    const now         = new Date();
    const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMEnd    = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalSuppliers, newSuppliersMonth,
      totalBuyers,    newBuyersMonth,
      activeRfqs,     completedOrdersMonth,
      revenueMonth,   revenuePrevMonth,
      openDisputes,   pendingVerif,
    ] = await Promise.all([
      this.prisma.company.count({ where: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } } }),
      this.prisma.company.count({ where: { type: 'SUPPLIER', createdAt: { gte: monthStart } } }),
      this.prisma.company.count({ where: { type: 'BUYER' } }),
      this.prisma.company.count({ where: { type: 'BUYER',  createdAt: { gte: monthStart } } }),
      this.prisma.rfqRequest.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.order.count({ where: { status: 'CONFIRMED', confirmedAt: { gte: monthStart } } }),
      this.prisma.order.aggregate({ where: { status: 'CONFIRMED', confirmedAt: { gte: monthStart } }, _sum: { amount: true } }),
      this.prisma.order.aggregate({ where: { status: 'CONFIRMED', confirmedAt: { gte: prevMStart, lte: prevMEnd } }, _sum: { amount: true } }),
      this.prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      this.prisma.verification.count({ where: { status: 'PENDING' } }),
    ]);

    const revM    = revenueMonth._sum.amount    || 0;
    const revPrev = revenuePrevMonth._sum.amount || 0;
    const commissionMonth = revM * 0.025; // avg 2.5% commission

    return {
      suppliers:  { total: totalSuppliers, newThisMonth: newSuppliersMonth },
      buyers:     { total: totalBuyers,    newThisMonth: newBuyersMonth },
      rfq:        { active: activeRfqs },
      orders:     { completedThisMonth: completedOrdersMonth },
      revenue:    {
        month:    revM,
        prevMonth: revPrev,
        growth:   revPrev > 0 ? +((revM - revPrev) / revPrev * 100).toFixed(1) : 0,
        commission: commissionMonth,
      },
      disputes:   { open: openDisputes },
      verification: { pending: pendingVerif },
      timestamp:  now.toISOString(),
    };
  }

  // ── BAN / UNBAN USER ─────────────────────────────────────────
  async banUser(userId: string, adminId: string, reason: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isBanned: true, banReason: reason },
    });
    // Revoke all active sessions
    await this.prisma.refreshToken.updateMany({
      where: { userId }, data: { isRevoked: true },
    });
    await this.prisma.auditLog.create({
      data: { userId: adminId, action: 'USER_BANNED', entity: 'User', entityId: userId, newValue: { reason } },
    });
    return { banned: true };
  }

  async unbanUser(userId: string, adminId: string) {
    await this.prisma.user.update({
      where: { id: userId }, data: { isBanned: false, banReason: null },
    });
    await this.prisma.auditLog.create({
      data: { userId: adminId, action: 'USER_UNBANNED', entity: 'User', entityId: userId },
    });
    return { unbanned: true };
  }

  // ── COMMISSION REPORT ─────────────────────────────────────────
  async getCommissionReport(from: Date, to: Date) {
    const orders = await this.prisma.order.findMany({
      where: { status: 'CONFIRMED', confirmedAt: { gte: from, lte: to } },
      include: {
        buyer:    { select: { nameAr: true } },
        supplier: { select: { nameAr: true } },
      },
      orderBy: { confirmedAt: 'desc' },
    });

    const total       = orders.reduce((s, o) => s + o.amount, 0);
    const totalComm   = orders.reduce((s, o) => s + o.commission, 0);
    const bySupplier  = orders.reduce((acc, o) => {
      const k = o.supplier.nameAr;
      acc[k] = (acc[k] || 0) + o.commission;
      return acc;
    }, {} as Record<string, number>);

    return {
      period: { from, to },
      orders: orders.length,
      totalAmount: total,
      totalCommission: totalComm,
      avgCommissionRate: total > 0 ? +((totalComm / total) * 100).toFixed(2) : 0,
      bySupplier: (Object.entries(bySupplier) as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      breakdown: orders.map(o => ({
        orderId:   o.id,
        buyer:     o.buyer.nameAr,
        supplier:  o.supplier.nameAr,
        amount:    o.amount,
        commission: o.commission,
        date:      o.confirmedAt,
      })),
    };
  }

  // ── COMPANY SEARCH (for admin pickers, e.g. attaching a directly-added product) ──
  async searchCompanies(q: string, type?: string) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.company.findMany({
      where: {
        nameAr: { contains: q, mode: 'insensitive' },
        ...(type ? { type } : {}),
      },
      select: { id: true, nameAr: true, type: true, verifiedLevel: true },
      take: 10,
    });
  }

  // ── DIRECT PRODUCT PUBLISH (admin picks a real registered company) ──
  async adminCreateProduct(dto: { companyId: string; categoryId: string; nameAr: string; unit: string; minQty?: number; priceMin?: number }) {
    const company = await this.prisma.company.findUnique({ where: { id: dto.companyId } });
    if (!company) throw new NotFoundException('الشركة غير موجودة');
    return this.prisma.product.create({
      data: {
        companyId: dto.companyId,
        categoryId: dto.categoryId,
        nameAr: dto.nameAr,
        unit: dto.unit,
        minQty: dto.minQty || 1,
        priceMin: dto.priceMin,
        specsJson: {},
        status: 'APPROVED',
      },
    });
  }
}
