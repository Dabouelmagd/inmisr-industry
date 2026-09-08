// ─── supplier-dashboard/supplier-dashboard.service.ts ─────────────
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class SupplierDashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(companyId: string) {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevEnd    = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      // Orders
      ordersThisMonth, ordersPrevMonth,
      revenueThisMonth, revenuePrevMonth,
      activeOrders,
      // RFQ
      pendingQuotes, activeRfqs, quotesAccepted,
      // Reviews
      recentReviews,
      // Trust
      company,
      // Escrow pending
      escrowHeld,
    ] = await Promise.all([
      this.prisma.order.count({ where: { supplierCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: monthStart } } }),
      this.prisma.order.count({ where: { supplierCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: prevStart, lte: prevEnd } } }),
      this.prisma.order.aggregate({ where: { supplierCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: monthStart } }, _sum: { netToSupplier: true } }),
      this.prisma.order.aggregate({ where: { supplierCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: prevStart, lte: prevEnd } }, _sum: { netToSupplier: true } }),
      this.prisma.order.count({ where: { supplierCompanyId: companyId, status: { in: ['ESCROW_FUNDED', 'SHIPPED'] } } }),
      this.prisma.rfqQuote.count({ where: { supplierCompanyId: companyId, status: 'PENDING' } }),
      this.prisma.rfqRequest.count({ where: { status: 'PUBLISHED', category: { companies: { some: { companyId } } } } }),
      this.prisma.rfqQuote.count({ where: { supplierCompanyId: companyId, status: 'ACCEPTED' } }),
      this.prisma.review.findMany({ where: { revieweeId: companyId }, orderBy: { createdAt: 'desc' }, take: 5, include: { reviewer: { select: { nameAr: true } } } }),
      this.prisma.company.findUnique({ where: { id: companyId }, include: { subscription: true, _count: { select: { products: true } } } }),
      this.prisma.escrow.aggregate({ where: { order: { supplierCompanyId: companyId }, status: 'HELD' }, _sum: { netToSupplier: true } }),
    ]);

    const rev  = revenueThisMonth._sum.netToSupplier || 0;
    const prev = revenuePrevMonth._sum.netToSupplier || 0;

    // Revenue by month (last 6)
    const revenueChart = await this.getRevenueChart(companyId, 6);

    return {
      kpis: {
        ordersThisMonth,
        ordersPrevMonth,
        ordersGrowth:  ordersThisMonth - ordersPrevMonth,
        revenueThisMonth: rev,
        revenuePrevMonth: prev,
        revenueGrowth: prev > 0 ? +((rev - prev) / prev * 100).toFixed(1) : 0,
        activeOrders,
        escrowPending: escrowHeld._sum.netToSupplier || 0,
        pendingQuotes,
        activeRfqs,
        quotesAccepted,
        quoteAcceptRate: pendingQuotes + quotesAccepted > 0
          ? +((quotesAccepted / (pendingQuotes + quotesAccepted)) * 100).toFixed(1) : 0,
        avgRating:      company?.avgRating || 0,
        trustScore:     company?.trustScore || 0,
        verifiedLevel:  company?.verifiedLevel,
        plan:           company?.subscription?.plan || 'FREE',
        productCount:   (company as any)?._count?.products || 0,
      },
      recentReviews: recentReviews.map(r => ({
        reviewer:  r.reviewer.nameAr,
        overall:   r.overallScore,
        quality:   r.qualityScore,
        time:      r.timeScore,
        comm:      r.commScore,
        comment:   r.comment,
        date:      r.createdAt,
      })),
      revenueChart,
      pendingActions: {
        rfqsToRespond: pendingQuotes,
        ordersToShip:  await this.prisma.order.count({ where: { supplierCompanyId: companyId, status: 'ESCROW_FUNDED' } }),
        docsToUpload:  await this.prisma.order.count({ where: { supplierCompanyId: companyId, status: 'SHIPPED', documents: { none: { type: 'QUALITY_CERT' } } } }),
      },
    };
  }

  private async getRevenueChart(companyId: string, months: number) {
    const data = [];
    for (let i = months - 1; i >= 0; i--) {
      const from = new Date();
      from.setDate(1); from.setMonth(from.getMonth() - i);
      const to = new Date(from); to.setMonth(to.getMonth() + 1); to.setDate(0);
      const agg = await this.prisma.order.aggregate({
        where: { supplierCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: from, lte: to } },
        _sum: { netToSupplier: true }, _count: { id: true },
      });
      data.push({
        month:   from.toLocaleDateString('ar-EG', { month: 'short', year: 'numeric' }),
        revenue: agg._sum.netToSupplier || 0,
        orders:  agg._count.id || 0,
      });
    }
    return data;
  }
}

// ─── buyer-dashboard/buyer-dashboard.service.ts ───────────────────
@Injectable()
export class BuyerDashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(companyId: string) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [
      totalSpend, spendThisMonth,
      activeOrders, completedOrders,
      activeRfqs, quotesReceived,
      loyalty, topSuppliers,
    ] = await Promise.all([
      this.prisma.order.aggregate({ where: { buyerCompanyId: companyId, status: { in: ['CONFIRMED', 'COMPLETED'] } }, _sum: { amount: true } }),
      this.prisma.order.aggregate({ where: { buyerCompanyId: companyId, status: { in: ['CONFIRMED', 'COMPLETED'] }, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      this.prisma.order.count({ where: { buyerCompanyId: companyId, status: { in: ['ESCROW_FUNDED', 'SHIPPED'] } } }),
      this.prisma.order.count({ where: { buyerCompanyId: companyId, status: 'CONFIRMED' } }),
      this.prisma.rfqRequest.count({ where: { buyerCompanyId: companyId, status: { in: ['PUBLISHED', 'QUOTES_RECEIVED'] } } }),
      this.prisma.rfqQuote.count({ where: { rfq: { buyerCompanyId: companyId }, status: 'PENDING', createdAt: { gte: new Date(Date.now() - 24 * 3600000) } } }),
      this.prisma.loyaltyPoints.findUnique({ where: { companyId } }),
      this.prisma.order.groupBy({
        by: ['supplierCompanyId'],
        where: { buyerCompanyId: companyId, status: 'CONFIRMED' },
        _count: { id: true },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 5,
      }),
    ]);

    // Enrich top suppliers
    const supplierIds = topSuppliers.map(s => s.supplierCompanyId);
    const supplierNames = await this.prisma.company.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, nameAr: true, trustScore: true, avgRating: true },
    });
    const nameMap = Object.fromEntries(supplierNames.map(s => [s.id, s]));

    // Spend chart
    const spendChart = await this.getSpendChart(companyId, 6);

    return {
      kpis: {
        totalSpend:      totalSpend._sum.amount || 0,
        spendThisMonth:  spendThisMonth._sum.amount || 0,
        activeOrders,
        completedOrders,
        activeRfqs,
        newQuotesToday:  quotesReceived,
        loyaltyPoints:   loyalty?.points || 0,
        loyaltyTier:     loyalty?.tier || 'BRONZE',
      },
      topSuppliers: topSuppliers.map(s => ({
        supplier:    nameMap[s.supplierCompanyId],
        orderCount:  s._count.id,
        totalSpend:  s._sum.amount || 0,
      })),
      spendChart,
      pendingActions: {
        quotesToReview:    activeRfqs,
        ordersToConfirm:   await this.prisma.order.count({ where: { buyerCompanyId: companyId, status: 'DELIVERED' } }),
        rfqsExpiringSoon:  await this.prisma.rfqRequest.count({ where: { buyerCompanyId: companyId, status: 'PUBLISHED', expiresAt: { lte: new Date(Date.now() + 24 * 3600000) } } }),
      },
    };
  }

  private async getSpendChart(companyId: string, months: number) {
    const data = [];
    for (let i = months - 1; i >= 0; i--) {
      const from = new Date(); from.setDate(1); from.setMonth(from.getMonth() - i);
      const to   = new Date(from); to.setMonth(to.getMonth() + 1); to.setDate(0);
      const agg  = await this.prisma.order.aggregate({
        where: { buyerCompanyId: companyId, status: 'CONFIRMED', confirmedAt: { gte: from, lte: to } },
        _sum: { amount: true }, _count: { id: true },
      });
      data.push({ month: from.toLocaleDateString('ar-EG', { month: 'short', year: 'numeric' }), spend: agg._sum.amount || 0, orders: agg._count.id || 0 });
    }
    return data;
  }
}

// Controllers
import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtGuard } from '../auth/jwt.guard';

@ApiTags('dashboard')
@Controller('dashboard')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class DashboardController {
  constructor(
    private supplierDash: SupplierDashboardService,
    private buyerDash:    BuyerDashboardService,
  ) {}

  @Get('supplier')
  @ApiOperation({ summary: 'لوحة تحكم المورد' })
  supplierDashboard(@Request() req: any) {
    return this.supplierDash.getDashboard(req.user.companyId);
  }

  @Get('buyer')
  @ApiOperation({ summary: 'لوحة تحكم المشتري' })
  buyerDashboard(@Request() req: any) {
    return this.buyerDash.getDashboard(req.user.companyId);
  }
}
