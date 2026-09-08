// ─── reports/reports.service.ts ───────────────────────────────────
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type ReportType = 'SUPPLIER_PERFORMANCE' | 'BUYER_ACTIVITY' | 'INVOICE' | 'COMMISSION' | 'MARKET_GAPS';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private prisma:  PrismaService,
    private config:  ConfigService,
  ) {}

  // ── SUPPLIER PERFORMANCE REPORT ───────────────────────────────
  async generateSupplierReport(companyId: string, period: { from: Date; to: Date }) {
    const [company, orders, reviews, rfqQuotes] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
        include: { location: true, categories: { include: { category: true } }, subscription: true },
      }),
      this.prisma.order.findMany({
        where: { supplierCompanyId: companyId, createdAt: { gte: period.from, lte: period.to } },
        include: { buyer: { select: { nameAr: true } }, escrow: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.review.findMany({
        where: { revieweeId: companyId, createdAt: { gte: period.from, lte: period.to } },
      }),
      this.prisma.rfqQuote.findMany({
        where: { supplierCompanyId: companyId, createdAt: { gte: period.from, lte: period.to } },
      }),
    ]);

    const completedOrders = orders.filter(o => o.status === 'CONFIRMED');
    const totalRevenue    = completedOrders.reduce((s, o) => s + o.netToSupplier, 0);
    const totalCommission = completedOrders.reduce((s, o) => s + o.commission, 0);
    const avgRating       = reviews.length
      ? reviews.reduce((s, r) => s + r.overallScore, 0) / reviews.length : 0;
    const quoteAcceptRate = rfqQuotes.length
      ? (rfqQuotes.filter(q => q.status === 'ACCEPTED').length / rfqQuotes.length) * 100 : 0;

    return {
      company: {
        nameAr:        company.nameAr,
        verifiedLevel: company.verifiedLevel,
        trustScore:    company.trustScore,
        plan:          company.subscription?.plan,
        sectors:       company.categories.map(c => c.category.nameAr).join('، '),
        city:          company.location?.city,
      },
      period,
      summary: {
        totalOrders:      orders.length,
        completedOrders:  completedOrders.length,
        cancelledOrders:  orders.filter(o => o.status === 'CANCELLED').length,
        disputedOrders:   orders.filter(o => o.status === 'DISPUTED').length,
        totalRevenue,
        totalCommission,
        netRevenue:       totalRevenue,
        avgOrderValue:    completedOrders.length ? totalRevenue / completedOrders.length : 0,
        avgRating:        +avgRating.toFixed(2),
        totalReviews:     reviews.length,
        quotesSent:       rfqQuotes.length,
        quotesAccepted:   rfqQuotes.filter(q => q.status === 'ACCEPTED').length,
        quoteAcceptRate:  +quoteAcceptRate.toFixed(1),
      },
      breakdown: {
        byMonth: this.groupByMonth(completedOrders),
        topBuyers: this.groupByBuyer(completedOrders),
      },
      orders: completedOrders.map(o => ({
        id:          o.id.slice(-8).toUpperCase(),
        buyer:       o.buyer.nameAr,
        amount:      o.amount,
        commission:  o.commission,
        net:         o.netToSupplier,
        status:      o.status,
        date:        o.createdAt,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── BUYER ACTIVITY REPORT ─────────────────────────────────────
  async generateBuyerReport(companyId: string, period: { from: Date; to: Date }) {
    const [company, orders, rfqs, financeApps] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
        include: { location: true, subscription: true, loyaltyPoints: true },
      }),
      this.prisma.order.findMany({
        where: { buyerCompanyId: companyId, createdAt: { gte: period.from, lte: period.to } },
        include: { supplier: { select: { nameAr: true, verifiedLevel: true } }, escrow: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.rfqRequest.findMany({
        where: { buyerCompanyId: companyId, createdAt: { gte: period.from, lte: period.to } },
        include: { category: true, quotes: true },
      }),
      this.prisma.financeApplication.findMany({
        where: { companyId, createdAt: { gte: period.from, lte: period.to } },
      }),
    ]);

    const completedOrders = orders.filter(o => o.status === 'CONFIRMED');
    const totalSpend      = completedOrders.reduce((s, o) => s + o.amount, 0);

    return {
      company: { nameAr: company.nameAr, city: company.location?.city, loyaltyPoints: company.loyaltyPoints?.points || 0 },
      period,
      summary: {
        totalRfqs:         rfqs.length,
        publishedRfqs:     rfqs.filter(r => r.status !== 'DRAFT').length,
        rfqsWithQuotes:    rfqs.filter(r => r.quotes.length > 0).length,
        totalOrders:       orders.length,
        completedOrders:   completedOrders.length,
        totalSpend,
        avgOrderValue:     completedOrders.length ? totalSpend / completedOrders.length : 0,
        financeUsed:       financeApps.filter(f => f.status === 'APPROVED').length,
        financeTotal:      financeApps.filter(f => f.status === 'APPROVED').reduce((s, f) => s + f.amount, 0),
      },
      topSuppliers:  this.groupBySupplier(completedOrders),
      topCategories: this.groupByCategory(rfqs),
      orders: completedOrders.map(o => ({
        id:       o.id.slice(-8).toUpperCase(),
        supplier: o.supplier.nameAr,
        level:    o.supplier.verifiedLevel,
        amount:   o.amount,
        date:     o.createdAt,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── GENERATE HTML REPORT (for PDF export via puppeteer/wkhtml) ─
  generateReportHtml(data: any, type: ReportType): string {
    const periodStr = `${new Date(data.period.from).toLocaleDateString('ar-EG')} — ${new Date(data.period.to).toLocaleDateString('ar-EG')}`;

    return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; color: #1a1a1a; background: #fff; }
  .header { background: #0D0D0D; color: #fff; padding: 24px 32px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-size: 20px; font-weight: 700; }
  .logo span { color: #CE1126; }
  .meta { font-size: 12px; color: #999; }
  .body { padding: 32px; }
  h2 { font-size: 18px; font-weight: 600; color: #0D0D0D; margin: 24px 0 14px; border-bottom: 2px solid #CE1126; padding-bottom: 6px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #F8F8F8; border-right: 3px solid #CE1126; padding: 14px; border-radius: 6px; }
  .kpi-label { font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .kpi-value { font-size: 22px; font-weight: 700; color: #0D0D0D; }
  .kpi-sub { font-size: 11px; color: #999; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 24px; }
  th { background: #F0F0F0; padding: 10px 12px; text-align: right; font-weight: 600; border-bottom: 2px solid #ddd; }
  td { padding: 9px 12px; border-bottom: 1px solid #eee; }
  tr:hover td { background: #FAFAFA; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
  .badge-green { background: #E8F5E9; color: #2E7D32; }
  .badge-red   { background: #FFEBEE; color: #C62828; }
  .badge-amber { background: #FFF8E1; color: #F57F17; }
  .footer { background: #F8F8F8; padding: 16px 32px; text-align: center; font-size: 11px; color: #999; margin-top: 32px; }
  .company-header { background: #F8F8F8; padding: 16px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 20px; }
  .company-field { font-size: 12px; }
  .company-field label { color: #888; display: block; margin-bottom: 2px; }
  .company-field strong { color: #0D0D0D; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">إن <span>مصر</span> للصناعة</div>
  <div class="meta">
    <div>تقرير الأداء — ${periodStr}</div>
    <div>تاريخ الإصدار: ${new Date(data.generatedAt).toLocaleDateString('ar-EG')}</div>
  </div>
</div>

<div class="body">
  <div class="company-header">
    <div class="company-field"><label>الشركة</label><strong>${data.company.nameAr}</strong></div>
    <div class="company-field"><label>المدينة</label><strong>${data.company.city || '—'}</strong></div>
    <div class="company-field"><label>مستوى التحقق</label><strong>${data.company.verifiedLevel || data.company.plan || '—'}</strong></div>
    ${data.company.trustScore ? `<div class="company-field"><label>Trust Score</label><strong>${data.company.trustScore}/100</strong></div>` : ''}
    ${data.company.loyaltyPoints ? `<div class="company-field"><label>نقاط الولاء</label><strong>${data.company.loyaltyPoints.toLocaleString()}</strong></div>` : ''}
  </div>

  <h2>ملخص الأداء</h2>
  <div class="kpi-grid">
    ${type === 'SUPPLIER_PERFORMANCE' ? `
    <div class="kpi"><div class="kpi-label">الطلبات المكتملة</div><div class="kpi-value">${data.summary.completedOrders}</div><div class="kpi-sub">من ${data.summary.totalOrders} إجمالي</div></div>
    <div class="kpi"><div class="kpi-label">صافي الإيرادات</div><div class="kpi-value">${(data.summary.netRevenue || 0).toLocaleString()}</div><div class="kpi-sub">ج.م</div></div>
    <div class="kpi"><div class="kpi-label">متوسط التقييم</div><div class="kpi-value">${data.summary.avgRating}</div><div class="kpi-sub">من ${data.summary.totalReviews} تقييم</div></div>
    <div class="kpi"><div class="kpi-label">معدل قبول العروض</div><div class="kpi-value">${data.summary.quoteAcceptRate}٪</div><div class="kpi-sub">${data.summary.quotesAccepted} من ${data.summary.quotesSent}</div></div>
    ` : `
    <div class="kpi"><div class="kpi-label">طلبات RFQ</div><div class="kpi-value">${data.summary.totalRfqs}</div><div class="kpi-sub">${data.summary.publishedRfqs} منشور</div></div>
    <div class="kpi"><div class="kpi-label">إجمالي الإنفاق</div><div class="kpi-value">${(data.summary.totalSpend || 0).toLocaleString()}</div><div class="kpi-sub">ج.م</div></div>
    <div class="kpi"><div class="kpi-label">الطلبات المكتملة</div><div class="kpi-value">${data.summary.completedOrders}</div><div class="kpi-sub">من ${data.summary.totalOrders} إجمالي</div></div>
    <div class="kpi"><div class="kpi-label">تمويل مستخدم</div><div class="kpi-value">${(data.summary.financeTotal || 0).toLocaleString()}</div><div class="kpi-sub">ج.م — ${data.summary.financeUsed} طلبات</div></div>
    `}
  </div>

  <h2>تفاصيل الطلبات</h2>
  <table>
    <thead>
      <tr>
        <th>رقم الطلب</th>
        <th>${type === 'SUPPLIER_PERFORMANCE' ? 'المشتري' : 'المورد'}</th>
        <th>المبلغ (ج.م)</th>
        ${type === 'SUPPLIER_PERFORMANCE' ? '<th>العمولة (ج.م)</th><th>الصافي (ج.م)</th>' : ''}
        <th>الحالة</th>
        <th>التاريخ</th>
      </tr>
    </thead>
    <tbody>
      ${(data.orders || []).slice(0, 30).map((o: any) => `
      <tr>
        <td><strong>${o.id}</strong></td>
        <td>${o.buyer || o.supplier}</td>
        <td><strong>${(o.amount || 0).toLocaleString()}</strong></td>
        ${type === 'SUPPLIER_PERFORMANCE' ? `<td>${(o.commission || 0).toLocaleString()}</td><td>${(o.net || 0).toLocaleString()}</td>` : ''}
        <td><span class="badge badge-green">مكتمل</span></td>
        <td>${new Date(o.date).toLocaleDateString('ar-EG')}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>

<div class="footer">
  إن مصر للصناعة — B2B Industrial Marketplace • inmisr.net<br>
  هذا التقرير سري ومخصص للاستخدام الداخلي فقط
</div>
</body>
</html>`;
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private groupByMonth(orders: any[]) {
    return orders.reduce((acc, o) => {
      const key = new Date(o.createdAt).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' });
      if (!acc[key]) acc[key] = { count: 0, revenue: 0 };
      acc[key].count++;
      acc[key].revenue += o.netToSupplier || o.amount;
      return acc;
    }, {} as Record<string, any>);
  }

  private groupByBuyer(orders: any[]) {
    const map = orders.reduce((acc, o) => {
      const key = o.buyer?.nameAr || 'غير محدد';
      if (!acc[key]) acc[key] = { count: 0, revenue: 0 };
      acc[key].count++;
      acc[key].revenue += o.netToSupplier || 0;
      return acc;
    }, {} as Record<string, any>);
    return Object.entries(map).sort((a: any, b: any) => b[1].revenue - a[1].revenue).slice(0, 5);
  }

  private groupBySupplier(orders: any[]) {
    const map = orders.reduce((acc, o) => {
      const key = o.supplier?.nameAr || 'غير محدد';
      if (!acc[key]) acc[key] = { count: 0, spend: 0 };
      acc[key].count++;
      acc[key].spend += o.amount;
      return acc;
    }, {} as Record<string, any>);
    return Object.entries(map).sort((a: any, b: any) => b[1].spend - a[1].spend).slice(0, 5);
  }

  private groupByCategory(rfqs: any[]) {
    const map = rfqs.reduce((acc, r) => {
      const key = r.category?.nameAr || 'غير محدد';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return Object.entries(map).sort((a: any, b: any) => b[1] - a[1]).slice(0, 5);
  }
}
