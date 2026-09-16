// ═══════════════════════════════════════════════════════════════════
// services/remaining.ts — Geo + Finance + Incubator + Orders + Messages
// ═══════════════════════════════════════════════════════════════════

import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';

// ══════════════════════════════════════════════════════════════════
// GEO SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── geo/geo.service.ts ───────────────────────────────────────────

@Injectable()
export class GeoService {
  private readonly logger = new Logger('GeoService');

  private readonly INDUSTRIAL_ZONES = [
    { id: '10th',      nameAr: 'العاشر من رمضان', lat: 30.294, lng: 31.743, suppliersCount: 0, sectors: ['iron', 'chemicals', 'food'] },
    { id: '6oct',      nameAr: '٦ أكتوبر',         lat: 29.970, lng: 30.930, suppliersCount: 0, sectors: ['petrochemicals', 'textile', 'aluminum'] },
    { id: 'obour',     nameAr: 'مدينة العبور',     lat: 30.249, lng: 31.818, suppliersCount: 0, sectors: ['food', 'pharma', 'packaging'] },
    { id: 'sadat',     nameAr: 'مدينة السادات',    lat: 30.369, lng: 30.528, suppliersCount: 0, sectors: ['furniture', 'textile', 'ceramics'] },
    { id: 'borg',      nameAr: 'برج العرب',         lat: 30.898, lng: 29.547, suppliersCount: 0, sectors: ['iron', 'chemicals', 'logistics'] },
    { id: 'borg_new',  nameAr: 'برج العرب الجديدة', lat: 30.8667, lng: 29.6167, suppliersCount: 0, sectors: ['textile', 'chemicals'] },
    { id: 'imbaba',    nameAr: 'إمبابة',            lat: 30.067, lng: 31.205, suppliersCount: 0, sectors: ['metals', 'mechanics', 'tools'] },
    { id: 'badr',      nameAr: 'مدينة بدر',         lat: 30.121, lng: 31.745, suppliersCount: 0, sectors: ['electronics', 'solar', 'cables'] },
    { id: 'shorouk',   nameAr: 'مدينة الشروق',     lat: 30.157, lng: 31.614, suppliersCount: 0, sectors: ['pharma', 'food', 'cosmetics'] },
    { id: 'mahalla',   nameAr: 'المحلة الكبرى',     lat: 30.973, lng: 31.167, suppliersCount: 0, sectors: ['textile'] },
    { id: 'robeiky',   nameAr: 'الروبيكي',          lat: 29.900, lng: 31.350, suppliersCount: 0, sectors: ['leather'] },
    { id: 'sokhna',    nameAr: 'العين السخنة',      lat: 29.600, lng: 32.317, suppliersCount: 0, sectors: ['petrochemicals', 'logistics'] },
    { id: 'damietta',  nameAr: 'دمياط',             lat: 31.4165, lng: 31.8133, suppliersCount: 0, sectors: ['furniture'] },
    { id: 'new_capital', nameAr: 'العاصمة الإدارية الجديدة', lat: 30.0200, lng: 31.7000, suppliersCount: 0, sectors: ['construction', 'logistics'] },
  ];

  // Shipping partners pricing (EGP per ton per km)
  private readonly SHIPPING_RATE = 15; // EGP / ton / km

  constructor(private prisma: PrismaService) {}

  async getMapData(query: { lat?: number; lng?: number; radiusKm?: number; sector?: string; type?: string }) {
    const companyType = query.type === 'BUYER' ? 'BUYER' : query.type === 'ALL' ? undefined : 'SUPPLIER';
    const where: any = { company: { ...(companyType ? { type: companyType } : {}), verifiedLevel: companyType === 'BUYER' ? undefined : { not: 'NONE' } } };

    if (query.sector) {
      where.company = {
        ...where.company,
        categories: { some: { category: { sectorCode: query.sector } } },
      };
    }

    const locations = await this.prisma.geoLocation.findMany({
      where,
      select: {
        // City/zone/coordinates are needed for the map and distance
        // calculations and stay visible -- addressAr/addressEn/postalCode
        // are the precise street address and are admin-only (see
        // AdminService.listFactories), never returned from this public
        // endpoint.
        city: true, governorate: true, industrialZone: true, lat: true, lng: true,
        company: {
          select: {
            id: true, nameAr: true, nameEn: true, type: true,
            verifiedLevel: true, trustScore: true, avgRating: true,
            totalDeals: true, avgResponseHours: true,
            subscription: { select: { plan: true } },
            categories: { include: { category: { select: { nameAr: true, sectorCode: true } } } },
          },
        },
      },
      take: 200,
    });

    const enriched = locations.map(loc => ({
      ...loc,
      distanceKm: query.lat && query.lng
        ? this.haversine(query.lat, query.lng, loc.lat, loc.lng)
        : null,
    }));

    if (query.lat && query.lng && query.radiusKm) {
      return enriched.filter(l => l.distanceKm !== null && l.distanceKm <= (query.radiusKm || 100));
    }

    return enriched;
  }

  // ── NEAREST SUPPLIERS TO A GIVEN BUYER — real distance, real ranking ──
  async getNearestSuppliers(buyerCompanyId: string, opts: { sector?: string; limit?: number }) {
    const buyerLoc = await this.prisma.geoLocation.findUnique({ where: { companyId: buyerCompanyId } });
    if (!buyerLoc) {
      throw new BadRequestException('لا يوجد موقع مسجّل لحسابك — أضيفي موقعك من صفحة بيانات الشركة أولاً');
    }

    const where: any = { company: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } } };
    if (opts.sector) {
      where.company.categories = { some: { category: { sectorCode: opts.sector } } };
    }

    const locations = await this.prisma.geoLocation.findMany({
      where,
      select: {
        city: true, governorate: true, industrialZone: true, lat: true, lng: true,
        company: {
          select: {
            id: true, nameAr: true, avgRating: true, trustScore: true, totalDeals: true,
            categories: { include: { category: { select: { nameAr: true } } } },
          },
        },
      },
      take: 300,
    });

    return locations
      .map(loc => ({ ...loc, distanceKm: this.haversine(buyerLoc.lat, buyerLoc.lng, loc.lat, loc.lng) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, opts.limit || 10);
  }

  async getIndustrialZones() {
    const counts = await this.prisma.geoLocation.groupBy({
      by: ['industrialZone'],
      where: { company: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } } },
      _count: { _all: true },
    });
    const countMap: Record<string, number> = {};
    for (const c of counts) {
      if (c.industrialZone) countMap[c.industrialZone] = c._count._all;
    }
    return this.INDUSTRIAL_ZONES.map(z => ({ ...z, suppliersCount: countMap[z.nameAr] || 0 }));
  }

  estimateShipping(q: { fromLat: number; fromLng: number; toLat: number; toLng: number; weightTons: number }) {
    const distanceKm = this.haversine(q.fromLat, q.fromLng, q.toLat, q.toLng);
    const baseCost = distanceKm * q.weightTons * this.SHIPPING_RATE;
    const platformDiscount = 0.20; // 20% discount for in-platform orders

    return {
      distanceKm: +distanceKm.toFixed(1),
      weightTons: q.weightTons,
      standardCost: +baseCost.toFixed(0),
      platformCost: +(baseCost * (1 - platformDiscount)).toFixed(0),
      saving: +(baseCost * platformDiscount).toFixed(0),
      estimatedDays: Math.max(1, Math.ceil(distanceKm / 400)),
      partners: [
        { name: 'شركة النيل للشحن',   price: +(baseCost * 0.82).toFixed(0), rating: 4.7 },
        { name: 'مصر للخدمات اللوجستية', price: +(baseCost * 0.85).toFixed(0), rating: 4.5 },
        { name: 'الدلتا للنقل الثقيل',  price: +(baseCost * 0.80).toFixed(0), rating: 4.3 },
      ],
    };
  }

  haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return +(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }
}

// ══════════════════════════════════════════════════════════════════
// FINANCE SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── finance/finance.service.ts ───────────────────────────────────

@Injectable()
export class FinanceService {
  private readonly logger = new Logger('FinanceService');

  private readonly PLANS = [
    {
      id: 'fast',
      nameAr: 'تمويل سريع',
      durationMonths: 3,
      annualRate: 0.06,
      maxAmount: 200000,
      approvalDays: 2,
      requiresCollateral: false,
      banks: ['CIB', 'DIB'],
      features: ['موافقة خلال ٤٨ ساعة', 'حتى ٢٠٠,٠٠٠ ج.م', 'بدون ضمانات', 'ربط مباشر بـ Escrow'],
    },
    {
      id: 'medium',
      nameAr: 'تمويل متوسط',
      durationMonths: 6,
      annualRate: 0.075,
      maxAmount: 500000,
      approvalDays: 3,
      requiresCollateral: false,
      banks: ['CIB', 'QNB'],
      features: ['موافقة خلال ٧٢ ساعة', 'حتى ٥٠٠,٠٠٠ ج.م', 'خصم ٠.٥٪ للسداد المبكر', 'تجديد تلقائي'],
      recommended: true,
    },
    {
      id: 'extended',
      nameAr: 'تمويل ممتد',
      durationMonths: 12,
      annualRate: 0.09,
      maxAmount: 2000000,
      approvalDays: 5,
      requiresCollateral: true,
      banks: ['CIB', 'QNB', 'DIB'],
      features: ['حتى ٢,٠٠٠,٠٠٠ ج.م', 'مدير حساب مخصص', 'تقارير مالية دورية', 'تجديد تلقائي'],
    },
  ];

  constructor(private prisma: PrismaService) {}

  getPlans() { return this.PLANS; }

  calculatePayment(principal: number, months: number, annualRate: number) {
    const r = annualRate / 100 / 12;
    const monthly = principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
    const total = monthly * months;
    const interest = total - principal;

    return {
      principal,
      months,
      annualRate,
      monthlyPayment: +monthly.toFixed(2),
      totalPayment: +total.toFixed(2),
      totalInterest: +interest.toFixed(2),
      effectiveApr: +(annualRate * 1.02).toFixed(2), // include fees
      schedule: Array.from({ length: months }, (_, i) => {
        const interestPayment = (principal - (monthly - principal * r) * i) * r;
        return {
          month: i + 1,
          payment: +monthly.toFixed(2),
          principal: +(monthly - interestPayment).toFixed(2),
          interest: +interestPayment.toFixed(2),
        };
      }),
    };
  }

  async applyForFinance(companyId: string, dto: any) {
    // Validate company has orders (track record)
    const orderCount = await this.prisma.order.count({
      where: { buyerCompanyId: companyId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    });

    if (orderCount < 2) {
      return {
        status: 'REQUIRES_MORE_HISTORY',
        message: 'يحتاج حسابك لإتمام ٢ صفقات على الأقل للتأهل للتمويل',
        currentOrders: orderCount,
        required: 2,
      };
    }

    const application = await this.prisma.financeApplication.create({
      data: {
        companyId,
        amount: dto.amount,
        durationMonths: dto.durationMonths,
        interestRate: dto.interestRate || 7.5,
        monthlyPayment: this.calculatePayment(dto.amount, dto.durationMonths, dto.interestRate || 7.5).monthlyPayment,
        bankPartner: dto.bankPartner || 'CIB',
        purpose: dto.purpose,
        orderId: dto.orderId,
        status: 'PENDING',
      },
    });

    this.logger.log(`Finance application ${application.id} created for company ${companyId}`);
    return { applicationId: application.id, status: 'PENDING', message: 'سيتم مراجعة طلبك خلال ٤٨ ساعة' };
  }

  async getApplications(companyId: string) {
    return this.prisma.financeApplication.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── ADMIN: review queue (owner dashboard "طلبات الخدمات الصناعية") ──
  async adminListApplications(status?: string) {
    return this.prisma.financeApplication.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const application = await this.prisma.financeApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException('طلب التمويل غير موجود');
    if (application.status !== 'PENDING') {
      throw new BadRequestException('تمت مراجعة هذا الطلب بالفعل');
    }
    const updated = await this.prisma.financeApplication.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', approvedAt: approve ? new Date() : null },
    });
    this.logger.log(`Finance application ${id} ${approve ? 'approved' : 'rejected'}`);
    return updated;
  }
}

// ══════════════════════════════════════════════════════════════════
// INSPECTION SERVICE — طلبات الفحص المعملي وتفتيش المصانع
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class InspectionService {
  private readonly logger = new Logger('InspectionService');

  constructor(private prisma: PrismaService) {}

  async submitTesting(companyId: string, dto: {
    requestType: string; product: string; quantity?: string; preferredDate?: string;
  }) {
    if (!dto.product?.trim()) throw new BadRequestException('اسم المنتج / الخامة مطلوب');
    return this.prisma.inspectionRequest.create({
      data: {
        companyId,
        kind: 'TESTING',
        requestType: dto.requestType,
        productOrFacility: dto.product,
        quantity: dto.quantity,
        preferredDate: dto.preferredDate ? new Date(dto.preferredDate) : null,
        status: 'PENDING',
      },
    });
  }

  async submitAudit(companyId: string, dto: {
    requestType: string; facility: string; preferredDate?: string;
  }) {
    if (!dto.facility?.trim()) throw new BadRequestException('اسم المنشأة مطلوب');
    return this.prisma.inspectionRequest.create({
      data: {
        companyId,
        kind: 'AUDIT',
        requestType: dto.requestType,
        productOrFacility: dto.facility,
        preferredDate: dto.preferredDate ? new Date(dto.preferredDate) : null,
        status: 'PENDING',
      },
    });
  }

  async listMine(companyId: string) {
    return this.prisma.inspectionRequest.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── ADMIN: review queue ───────────────────────────────────────
  async adminList(kind?: string, status?: string) {
    const where: any = {};
    if (kind) where.kind = kind;
    if (status) where.status = status;
    return this.prisma.inspectionRequest.findMany({
      where,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean, notes?: string) {
    const request = await this.prisma.inspectionRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا الطلب بالفعل');
    return this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', reviewNotes: notes },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// TRAINING SERVICE — تسجيلات دورات الشركات والمصانع
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class TrainingService {
  constructor(private prisma: PrismaService) {}

  async enroll(companyId: string, courseName: string) {
    if (!courseName?.trim()) throw new BadRequestException('اسم الدورة مطلوب');
    return this.prisma.trainingEnrollment.create({
      data: { companyId, courseName, status: 'CONFIRMED' },
    });
  }

  async listMine(companyId: string) {
    return this.prisma.trainingEnrollment.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.trainingEnrollment.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminCancel(id: string) {
    const enrollment = await this.prisma.trainingEnrollment.findUnique({ where: { id } });
    if (!enrollment) throw new NotFoundException('التسجيل غير موجود');
    return this.prisma.trainingEnrollment.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
}

// ══════════════════════════════════════════════════════════════════
// FACTORY NEEDS SERVICE — طلبات احتياج المصانع الكبرى للصناعات المغذية
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// CUSTOM INDUSTRIAL SERVICE — خدمات صناعية يضيفها الأدمن بنفسه
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class CustomIndustrialServiceService {
  constructor(private prisma: PrismaService) {}

  async list() {
    return this.prisma.customIndustrialService.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: { name: string; description: string; icon?: string }) {
    if (!dto.name?.trim()) throw new BadRequestException('اسم الخدمة مطلوب');
    if (!dto.description?.trim()) throw new BadRequestException('وصف الخدمة مطلوب');
    return this.prisma.customIndustrialService.create({
      data: { name: dto.name, description: dto.description, icon: dto.icon || '🛠️' },
    });
  }

  async remove(id: string) {
    const svc = await this.prisma.customIndustrialService.findUnique({ where: { id } });
    if (!svc) throw new NotFoundException('الخدمة غير موجودة');
    return this.prisma.customIndustrialService.update({ where: { id }, data: { isActive: false } });
  }
}

@Injectable()
export class FactoryNeedService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async submit(companyId: string, dto: { needType: string; description: string; quantity?: string }) {
    if (!dto.description?.trim()) throw new BadRequestException('وصف الاحتياج مطلوب');
    return this.prisma.factoryNeed.create({
      data: {
        companyId,
        needType: dto.needType,
        description: dto.description,
        quantity: dto.quantity,
        status: 'PENDING',
      },
    });
  }

  // Public feed: visible immediately (with a pending badge), only
  // hidden once an admin explicitly rejects it -- matches the existing
  // "سيظهر فورًا" (shows immediately) promise made in the public UI.
  async listPublic() {
    return this.prisma.factoryNeed.findMany({
      where: { status: { not: 'REJECTED' } },
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  async listMine(companyId: string) {
    return this.prisma.factoryNeed.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.factoryNeed.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const need = await this.prisma.factoryNeed.findUnique({ where: { id } });
    if (!need) throw new NotFoundException('الطلب غير موجود');
    if (need.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا الطلب بالفعل');
    return this.prisma.factoryNeed.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' },
    });
  }

  // ── OFFERS — real 'تقديم عرض' responses to a posted need ────────
  async submitOffer(factoryNeedId: string, respondentCompanyId: string, dto: { message?: string }) {
    const need = await this.prisma.factoryNeed.findUnique({
      where: { id: factoryNeedId },
      include: { company: { include: { user: true } } },
    });
    if (!need) throw new NotFoundException('الطلب غير موجود');
    if (need.companyId === respondentCompanyId) throw new BadRequestException('لا يمكنك التقديم على طلبك الخاص');

    const offer = await this.prisma.factoryNeedOffer.create({
      data: { factoryNeedId, respondentCompanyId, message: dto.message },
    });

    if (need.company.user) {
      await this.notifications.send(
        need.company.user.id, 'RFQ_QUOTE_RECEIVED',
        'اهتمام جديد بطلب الاحتياج الخاص بك',
        `شركة مسجّلة أبدت اهتمامًا بطلبك: ${need.needType} — ${need.description}`,
        { factoryNeedId },
      );
    }

    return offer;
  }

  async listOffersForNeed(factoryNeedId: string, requesterCompanyId: string) {
    const need = await this.prisma.factoryNeed.findUnique({ where: { id: factoryNeedId } });
    if (!need) throw new NotFoundException('الطلب غير موجود');
    if (need.companyId !== requesterCompanyId) throw new ForbiddenException('غير مصرح لك بعرض ردود هذا الطلب');
    return this.prisma.factoryNeedOffer.findMany({
      where: { factoryNeedId },
      include: { respondent: { select: { nameAr: true, trustScore: true, avgRating: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// MARKET GAP ANALYSIS — فرص استثمارية حقيقية من بيانات RFQ والموردين
// الفعلية. لا يوجد نمذجة مالية حقيقية (لا بيانات استثمار/ROI حقيقية
// متاحة) — المؤشرات المعروضة كلها إشارات طلب/عرض حقيقية وقابلة
// للتحقق: عدد طلبات عروض الأسعار الحقيقية، عدد الردود الحقيقية،
// عدد الموردين المسجّلين فعليًا في القطاع.
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class MarketGapService {
  constructor(private prisma: PrismaService) {}

  async getOpportunities() {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, nameAr: true, sectorCode: true, iconEmoji: true },
    });

    const results: any[] = [];
    for (const cat of categories) {
      const rfqs = await this.prisma.rfqRequest.findMany({
        where: { categoryId: cat.id, status: { in: ['PUBLISHED', 'QUOTES_RECEIVED', 'UNDER_NEGOTIATION', 'ACCEPTED'] } },
        select: { id: true, deliveryCity: true },
      });
      if (rfqs.length < 2) continue; // not enough real signal to call it a pattern

      const rfqIds = rfqs.map(r => r.id);
      const quoteCount = await this.prisma.rfqQuote.count({ where: { rfqId: { in: rfqIds } } });
      const supplierCount = await this.prisma.companyCategory.count({ where: { categoryId: cat.id } });

      const avgQuotesPerRfq = quoteCount / rfqs.length;
      // Real signal, not a financial projection: more real demand (rfqCount)
      // combined with fewer real responses per request and fewer registered
      // suppliers = a bigger real, verifiable supply gap.
      const gapScore = (rfqs.length * 10) / ((avgQuotesPerRfq + 1) * (supplierCount + 1));

      const cityCounts: Record<string, number> = {};
      for (const r of rfqs) { if (r.deliveryCity) cityCounts[r.deliveryCity] = (cityCounts[r.deliveryCity] || 0) + 1; }
      const topCity = Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      results.push({
        categoryId: cat.id, categoryName: cat.nameAr, icon: cat.iconEmoji || '🏭',
        rfqCount: rfqs.length, quoteCount, supplierCount,
        avgQuotesPerRfq: +avgQuotesPerRfq.toFixed(1),
        gapScore: +gapScore.toFixed(1),
        topCity,
      });
    }

    results.sort((a, b) => b.gapScore - a.gapScore);
    return results.slice(0, 6);
  }
}

// ══════════════════════════════════════════════════════════════════
// DASHBOARD ACTIVITY — نشاط أخير حقيقي مبني على تحديثات الطلبات
// الفعلية والتقييمات، بدل قائمة ثابتة من بيانات تجريبية.
// ══════════════════════════════════════════════════════════════════

const ORDER_STATUS_ACTIVITY: Record<string, { icon: string; text: (o: any) => string }> = {
  ESCROW_FUNDED: { icon: '🔒', text: o => 'تم تحميل الضمان (Escrow) — طلب #' + o.id.slice(0, 8) },
  IN_PRODUCTION: { icon: '🏭', text: o => 'بدأ التصنيع — طلب #' + o.id.slice(0, 8) },
  SHIPPED: { icon: '🚚', text: o => 'تم شحن الطلب #' + o.id.slice(0, 8) },
  DELIVERED: { icon: '📦', text: o => 'تم تسليم الطلب #' + o.id.slice(0, 8) },
  CONFIRMED: { icon: '✅', text: o => 'تم تأكيد استلام الطلب #' + o.id.slice(0, 8) },
  COMPLETED: { icon: '🎉', text: o => 'اكتمل الطلب #' + o.id.slice(0, 8) },
  DISPUTED: { icon: '⚠️', text: o => 'تم فتح نزاع على الطلب #' + o.id.slice(0, 8) },
  REFUNDED: { icon: '↩️', text: o => 'تم استرداد المبلغ — طلب #' + o.id.slice(0, 8) },
};

@Injectable()
export class DashboardActivityService {
  constructor(private prisma: PrismaService) {}

  async getRecentActivity(companyId: string) {
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ buyerCompanyId: companyId }, { supplierCompanyId: companyId }] },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { id: true, status: true, updatedAt: true },
    });

    const reviews = await this.prisma.review.findMany({
      where: { reviewerId: companyId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { reviewee: { select: { nameAr: true } } },
    });

    const items: { icon: string; text: string; at: Date }[] = [];

    for (const o of orders) {
      const info = ORDER_STATUS_ACTIVITY[o.status];
      if (info) items.push({ icon: info.icon, text: info.text(o), at: o.updatedAt });
    }
    for (const r of reviews) {
      items.push({
        icon: '⭐',
        text: 'قيّمتِ ' + (r.reviewee?.nameAr || 'الطرف الآخر') + ' بـ' + r.overallScore.toFixed(1) + ' نجوم',
        at: r.createdAt,
      });
    }

    items.sort((a, b) => b.at.getTime() - a.at.getTime());
    return items.slice(0, 6);
  }
}

// ══════════════════════════════════════════════════════════════════
// SUPPLY CHAIN CONTROL TOWER — تتبع شحنات حقيقي مبني على الطلبات
// (Orders) الفعلية. لا يوجد تكامل حقيقي مع جهات جمركية أو GPS —
// المراحل وحالة الجمارك بيانات يحدّثها المورد أو الأدمن يدويًا،
// وده نفس النمط المستخدم في أغلب منصات B2B من غير تكامل لوجيستي عميق.
// ══════════════════════════════════════════════════════════════════

const SHIPMENT_STAGES = ['SUPPLIER_PICKUP', 'QUALITY_CHECK', 'CUSTOMS_CLEARANCE', 'IN_TRANSIT', 'DELIVERED'];

@Injectable()
export class SupplyChainService {
  constructor(private prisma: PrismaService) {}

  async getControlTowerDashboard() {
    const activeShipments = await this.prisma.order.count({ where: { status: 'SHIPPED' } });

    const activeShipmentOrders = await this.prisma.order.findMany({
      where: { status: 'SHIPPED' },
      select: { id: true, shipmentTracking: { select: { id: true, estimatedDelivery: true } } },
    });
    const withTracking = activeShipmentOrders.filter(o => o.shipmentTracking).length;
    const visibilityPct = activeShipments > 0 ? Math.round((withTracking / activeShipments) * 100) : 0;

    const now = new Date();
    const delayAlerts = activeShipmentOrders.filter(
      o => o.shipmentTracking?.estimatedDelivery && o.shipmentTracking.estimatedDelivery < now,
    ).length;

    const completed = await this.prisma.order.findMany({
      where: { confirmedAt: { not: null }, deliveredAt: { not: null } },
      select: { confirmedAt: true, deliveredAt: true },
      take: 200,
      orderBy: { deliveredAt: 'desc' },
    });
    const avgCycleDays = completed.length
      ? +(completed.reduce((sum, o) => sum + (o.deliveredAt!.getTime() - o.confirmedAt!.getTime()) / 86400000, 0) / completed.length).toFixed(1)
      : null;

    return { activeShipments, visibilityPct, delayAlerts, avgCycleDays, sampleSize: completed.length };
  }

  async listActiveShipments() {
    const orders = await this.prisma.order.findMany({
      where: { status: 'SHIPPED' },
      include: {
        buyer: { select: { nameAr: true, location: { select: { city: true } } } },
        supplier: { select: { nameAr: true, location: { select: { city: true } } } },
        shipmentTracking: true,
      },
      orderBy: { confirmedAt: 'desc' },
      take: 30,
    });
    return orders.map(o => ({
      orderId: o.id, amount: o.amount,
      buyerName: o.buyer?.nameAr, buyerCity: o.buyer?.location?.city,
      supplierName: o.supplier?.nameAr, supplierCity: o.supplier?.location?.city,
      currentStage: o.shipmentTracking?.currentStage || null,
      customsStatus: o.shipmentTracking?.customsStatus || null,
      customsNote: o.shipmentTracking?.customsNote || null,
      estimatedDelivery: o.shipmentTracking?.estimatedDelivery || null,
      hasTracking: !!o.shipmentTracking,
    }));
  }

  async getOrderTracking(orderId: string, requesterCompanyId: string, isAdmin: boolean) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { shipmentTracking: true, buyer: { select: { nameAr: true } }, supplier: { select: { nameAr: true } } },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (!isAdmin && order.buyerCompanyId !== requesterCompanyId && order.supplierCompanyId !== requesterCompanyId) {
      throw new ForbiddenException('ليس لديك صلاحية لعرض هذا الطلب');
    }
    return order;
  }

  async updateShipmentTracking(
    orderId: string, requesterCompanyId: string, requesterUserId: string, isAdmin: boolean,
    dto: { currentStage?: string; customsStatus?: string; customsNote?: string; estimatedDelivery?: string },
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (!isAdmin && order.supplierCompanyId !== requesterCompanyId) {
      throw new ForbiddenException('تحديث حالة الشحنة متاح للمورد أو فريق الإدارة فقط');
    }
    if (dto.currentStage && !SHIPMENT_STAGES.includes(dto.currentStage)) {
      throw new BadRequestException('مرحلة الشحنة غير معروفة');
    }
    const data: any = {
      currentStage: dto.currentStage, customsStatus: dto.customsStatus, customsNote: dto.customsNote,
      updatedByUserId: requesterUserId,
    };
    if (dto.estimatedDelivery) {
      const d = new Date(dto.estimatedDelivery);
      if (isNaN(d.getTime())) throw new BadRequestException('تاريخ التسليم المتوقع غير صحيح');
      data.estimatedDelivery = d;
    }
    return this.prisma.shipmentTracking.upsert({
      where: { orderId },
      create: { orderId, ...data },
      update: data,
    });
  }

  async listCustomsStatuses() {
    const tracking = await this.prisma.shipmentTracking.findMany({
      where: { customsStatus: { not: 'NOT_APPLICABLE' } },
      include: { order: { select: { id: true, status: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return tracking
      .filter(t => t.order.status === 'SHIPPED') // only currently-in-transit shipments are relevant here
      .map(t => ({ orderId: t.orderId, customsStatus: t.customsStatus, customsNote: t.customsNote }));
  }
}

// ══════════════════════════════════════════════════════════════════
// REVERSE LOGISTICS SERVICE — طلبات استرجاع / مرتجعات الخامات
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class ReverseLogisticsService {
  constructor(private prisma: PrismaService) {}

  async submit(companyId: string, dto: { product: string; quantity?: string; reason: string }) {
    if (!dto.product?.trim()) throw new BadRequestException('اسم المنتج / الخامة المرتجعة مطلوب');
    return this.prisma.reverseLogisticsRequest.create({
      data: { companyId, product: dto.product, quantity: dto.quantity, reason: dto.reason, status: 'PENDING' },
    });
  }

  async listMine(companyId: string) {
    return this.prisma.reverseLogisticsRequest.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.reverseLogisticsRequest.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const request = await this.prisma.reverseLogisticsRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا الطلب بالفعل');
    return this.prisma.reverseLogisticsRequest.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// JOB POSTING SERVICE — إعلانات وظائف المصانع (طلب عمالة)
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class JobPostingService {
  constructor(private prisma: PrismaService) {}

  async submit(companyId: string, dto: { jobType: string; count: number; region?: string; details?: string }) {
    if (!dto.jobType?.trim()) throw new BadRequestException('نوع الوظيفة مطلوب');
    if (!dto.count || dto.count <= 0) throw new BadRequestException('عدد العمال المطلوب يجب أن يكون أكبر من صفر');
    return this.prisma.jobPosting.create({
      data: { companyId, jobType: dto.jobType, count: dto.count, region: dto.region, details: dto.details, status: 'PENDING' },
    });
  }

  // Public feed: visible immediately (with a pending badge), hidden only if rejected.
  async listPublic() {
    return this.prisma.jobPosting.findMany({
      where: { status: { not: 'REJECTED' } },
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  async listMine(companyId: string) {
    return this.prisma.jobPosting.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.jobPosting.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const posting = await this.prisma.jobPosting.findUnique({ where: { id } });
    if (!posting) throw new NotFoundException('الإعلان غير موجود');
    if (posting.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا الإعلان بالفعل');
    return this.prisma.jobPosting.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// SME PROJECT SERVICE — مشروعات الشباب المقترحة للحاضنة (بدون تسجيل دخول)
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class SmeProjectService {
  constructor(private prisma: PrismaService) {}

  // No auth required — youth submitters don't need a platform account.
  async submit(dto: {
    name: string; ownerName: string; ownerPhone?: string;
    sectorLabel: string; region: string; investmentReq: number; summary: string;
  }) {
    if (!dto.name?.trim() || !dto.ownerName?.trim()) {
      throw new BadRequestException('اسم المشروع واسم صاحبه مطلوبان');
    }
    return this.prisma.smeProject.create({
      data: {
        name: dto.name, ownerName: dto.ownerName, ownerPhone: dto.ownerPhone,
        sectorLabel: dto.sectorLabel, region: dto.region,
        investmentReq: dto.investmentReq || 0, summary: dto.summary || '',
        status: 'PENDING',
      },
    });
  }

  // Public feed: approved-only (hard gate — matches the original
  // "مشروعك يبقى خاصاً حتى تتم الموافقة عليه" promise made at submission).
  async listPublic() {
    return this.prisma.smeProject.findMany({
      where: { status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  async adminList(status?: string) {
    return this.prisma.smeProject.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const project = await this.prisma.smeProject.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('المشروع غير موجود');
    if (project.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا المشروع بالفعل');
    return this.prisma.smeProject.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' },
    });
  }

  // Toggle an already-approved project's public visibility without
  // re-running the pending->approved review (matches the original
  // toggleSmeVisibility behavior).
  async toggleVisibility(id: string) {
    const project = await this.prisma.smeProject.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('المشروع غير موجود');
    if (project.status !== 'APPROVED' && project.status !== 'HIDDEN') {
      throw new BadRequestException('لازم الموافقة على المشروع أولاً قبل التحكم في ظهوره');
    }
    return this.prisma.smeProject.update({
      where: { id }, data: { status: project.status === 'APPROVED' ? 'HIDDEN' : 'APPROVED' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// PROMO CODE SERVICE — أكواد خصم/دعوة يُنشئها الأونر (أدمن فقط بالكامل)
// ══════════════════════════════════════════════════════════════════

function generatePromoCodeString(type: string): string {
  const prefixMap: Record<string, string> = {
    free_invite: 'FREE', sub_3: 'SUB3', sub_6: 'SUB6', sub_9: 'SUB9',
    sub_12: 'SUB12', gift: 'GIFT', lifetime: 'LIFE',
  };
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'INMISR-' + (prefixMap[type] || 'CODE') + '-' + rand;
}

@Injectable()
export class PromoCodeService {
  constructor(private prisma: PrismaService) {}

  async list() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(adminId: string, dto: { type: string; plan: string; uses?: number; note?: string }) {
    const uses = dto.uses && dto.uses > 0 ? dto.uses : 1;
    let code = generatePromoCodeString(dto.type);
    // Vanishingly unlikely, but guard against a random collision anyway.
    while (await this.prisma.promoCode.findUnique({ where: { code } })) {
      code = generatePromoCodeString(dto.type);
    }
    return this.prisma.promoCode.create({
      data: {
        code, type: dto.type, plan: dto.plan,
        totalUses: uses, usesLeft: uses,
        note: dto.note, status: 'ACTIVE', createdBy: adminId,
      },
    });
  }

  async revoke(id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('الكود غير موجود');
    return this.prisma.promoCode.update({ where: { id }, data: { status: 'REVOKED', usesLeft: 0 } });
  }
}

// ══════════════════════════════════════════════════════════════════
// TRADE APPLICATION SERVICE — تقديم أفراد على وظائف/فرص حرفية (بدون تسجيل دخول)
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class TradeApplicationService {
  constructor(private prisma: PrismaService) {}

  async submit(workerId: string, dto: { name: string; phone: string; governorate?: string; appliedFor: string; type: string }) {
    if (!dto.name?.trim() || !dto.phone?.trim()) {
      throw new BadRequestException('الاسم ورقم التليفون مطلوبان');
    }
    return this.prisma.tradeApplication.create({
      data: {
        workerId, name: dto.name, phone: dto.phone, governorate: dto.governorate,
        appliedFor: dto.appliedFor, type: dto.type, contacted: false,
      },
    });
  }

  async listMine(workerId: string) {
    return this.prisma.tradeApplication.findMany({
      where: { workerId }, orderBy: { createdAt: 'desc' },
    });
  }

  async adminList() {
    return this.prisma.tradeApplication.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async adminToggleContacted(id: string) {
    const app = await this.prisma.tradeApplication.findUnique({ where: { id } });
    if (!app) throw new NotFoundException('الطلب غير موجود');
    return this.prisma.tradeApplication.update({ where: { id }, data: { contacted: !app.contacted } });
  }
}

// ══════════════════════════════════════════════════════════════════
// SPECIAL OFFER SERVICE — عروض خاصة يقدّمها الموردون على منتجاتهم
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class SpecialOfferService {
  constructor(private prisma: PrismaService) {}

  async submit(companyId: string, dto: {
    sectorLabel: string; name: string; originalPrice: number; discountPrice: number;
    qty?: string; minQty?: string; expiryDate?: string; description?: string;
  }) {
    if (!dto.name?.trim()) throw new BadRequestException('اسم المنتج مطلوب');
    if (!dto.originalPrice || !dto.discountPrice || dto.discountPrice >= dto.originalPrice) {
      throw new BadRequestException('سعر العرض يجب أن يكون أقل من السعر الأصلي');
    }
    return this.prisma.specialOffer.create({
      data: {
        companyId, sectorLabel: dto.sectorLabel, name: dto.name,
        originalPrice: dto.originalPrice, discountPrice: dto.discountPrice,
        qty: dto.qty, minQty: dto.minQty,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        description: dto.description, status: 'PENDING',
      },
    });
  }

  // Public feed: approved only, hides anything past its expiry date.
  async listPublic(sector?: string) {
    const now = new Date();
    return this.prisma.specialOffer.findMany({
      where: {
        status: 'APPROVED',
        OR: [{ expiryDate: null }, { expiryDate: { gte: now } }],
        sectorLabel: sector || undefined,
      },
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listMine(companyId: string) {
    return this.prisma.specialOffer.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(status?: string) {
    return this.prisma.specialOffer.findMany({
      where: status ? { status } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const offer = await this.prisma.specialOffer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundException('العرض غير موجود');
    if (offer.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا العرض بالفعل');
    return this.prisma.specialOffer.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// SOLAR LEAD SERVICE — طلبات استشارة مبادرة "شمسك.. طاقتك" (بدون تسجيل دخول)
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class SolarLeadService {
  constructor(private prisma: PrismaService) {}

  async submit(dto: {
    companyName: string; sector?: string; region?: string; contactName: string;
    phone: string; email?: string; monthlyBill?: string; roofArea?: string; notes?: string;
  }) {
    if (!dto.companyName?.trim() || !dto.contactName?.trim() || !dto.phone?.trim()) {
      throw new BadRequestException('اسم المنشأة واسم المسؤول ورقم الهاتف مطلوبون');
    }
    return this.prisma.solarLead.create({
      data: {
        companyName: dto.companyName, sector: dto.sector, region: dto.region,
        contactName: dto.contactName, phone: dto.phone, email: dto.email,
        monthlyBill: dto.monthlyBill, roofArea: dto.roofArea, notes: dto.notes,
        status: 'PENDING',
      },
    });
  }

  async adminList() {
    return this.prisma.solarLead.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async adminUpdateStatus(id: string, status: string) {
    if (!['PENDING', 'CONTACTED', 'APPROVED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('حالة غير معروفة');
    }
    const lead = await this.prisma.solarLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('الطلب غير موجود');
    return this.prisma.solarLead.update({ where: { id }, data: { status } });
  }
}

// ══════════════════════════════════════════════════════════════════
// SERVICE CONSULTATION SERVICE — طلبات مشورة شحن + تغليف مخصص (بدون تسجيل دخول)
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class ServiceConsultationService {
  constructor(private prisma: PrismaService) {}

  async submit(kind: string, dto: { companyName: string; phone?: string; details?: any }) {
    if (!dto.companyName?.trim()) throw new BadRequestException('اسم الشركة مطلوب');
    return this.prisma.serviceConsultation.create({
      data: { kind, companyName: dto.companyName, phone: dto.phone, detailsJson: dto.details || {}, status: 'PENDING' },
    });
  }

  async adminList(kind?: string) {
    return this.prisma.serviceConsultation.findMany({
      where: kind ? { kind } : undefined, orderBy: { createdAt: 'desc' },
    });
  }

  async adminUpdateStatus(id: string, status: string) {
    const item = await this.prisma.serviceConsultation.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('الطلب غير موجود');
    return this.prisma.serviceConsultation.update({ where: { id }, data: { status } });
  }
}

// ══════════════════════════════════════════════════════════════════
// COMPANY PROFILE SERVICE — تعديل بيانات الشركة/المنشأة الخاصة بالمستخدم
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class CompanyProfileService {
  constructor(private prisma: PrismaService) {}

  async getMine(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        location: true,
        categories: { include: { category: { select: { nameAr: true } } } },
        subscription: true,
      },
    });
    if (!company) throw new NotFoundException('لا يوجد ملف شركة مرتبط بحسابك');

    // Real KPIs for the supplier dashboard overview cards — computed here
    // rather than shipped as separate hardcoded numbers on the frontend.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [monthRevenueAgg, pendingRfqCount] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          supplierCompanyId: companyId,
          status: { in: ['CONFIRMED', 'COMPLETED'] },
          confirmedAt: { gte: monthStart },
        },
        _sum: { netToSupplier: true },
      }),
      this.prisma.rfqQuote.count({
        where: { supplierCompanyId: companyId, status: 'PENDING' },
      }),
    ]);

    return {
      ...company,
      monthRevenue: monthRevenueAgg._sum.netToSupplier || 0,
      pendingRfqCount,
    };
  }

  async updateMine(companyId: string, dto: {
    nameAr?: string; nameEn?: string; commercialRegNo?: string; taxId?: string;
    descriptionAr?: string; websiteUrl?: string; founded?: number; employeeCount?: number;
    contactPhone?: string; addressAr?: string; city?: string; governorate?: string; industrialZone?: string;
    logoUrl?: string;
  }) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, include: { location: true } });
    if (!company) throw new NotFoundException('لا يوجد ملف شركة مرتبط بحسابك');
    return this.prisma.company.update({
      where: { id: companyId },
      data: {
        nameAr: dto.nameAr, nameEn: dto.nameEn, commercialRegNo: dto.commercialRegNo, taxId: dto.taxId,
        descriptionAr: dto.descriptionAr, websiteUrl: dto.websiteUrl, contactPhone: dto.contactPhone,
        logoUrl: dto.logoUrl,
        founded: dto.founded ? Number(dto.founded) : undefined,
        employeeCount: dto.employeeCount != null ? String(dto.employeeCount) : undefined,
        location: dto.addressAr || dto.city ? {
          upsert: {
            create: {
              addressAr: dto.addressAr, city: dto.city || 'غير محدد', governorate: dto.governorate || dto.city || 'غير محدد',
              industrialZone: dto.industrialZone, lat: 30.0444, lng: 31.2357,
            },
            update: {
              addressAr: dto.addressAr ?? undefined, city: dto.city ?? undefined,
              governorate: dto.governorate ?? undefined, industrialZone: dto.industrialZone ?? undefined,
            },
          },
        } : undefined,
      },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// COMPANY ASSISTANT SERVICE — مساعدون بحسابات مستقلة وصلاحيات محددة
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class CompanyAssistantService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async invite(companyId: string, dto: { email: string; name?: string; roleLabel: string; permissions: string[] }) {
    if (!dto.email?.trim()) throw new BadRequestException('البريد الإلكتروني مطلوب');
    if (!dto.roleLabel?.trim()) throw new BadRequestException('الوظيفة مطلوبة');

    const existingUser = await this.prisma.user.findFirst({ where: { email: { equals: dto.email, mode: 'insensitive' } } });
    if (existingUser) throw new BadRequestException('هذا البريد الإلكتروني مستخدم بالفعل لحساب آخر على المنصة');

    const inviteToken = uuidv4();
    const assistant = await this.prisma.companyAssistant.create({
      data: {
        companyId, inviteEmail: dto.email, name: dto.name, roleLabel: dto.roleLabel,
        permissions: dto.permissions || [], status: 'PENDING', inviteToken,
      },
    });

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const inviteUrl = `https://inmisr.net/?accept-invite=${inviteToken}`;
    await this.notifications.sendEmail(
      dto.email,
      `دعوة للانضمام لحساب ${company?.nameAr || 'شركة'} على إن مصر للصناعة`,
      `تمت دعوتك للانضمام كـ ${dto.roleLabel}. لتفعيل حسابك افتحي الرابط: ${inviteUrl}`,
      `<p>تمت دعوتك للانضمام لحساب <b>${company?.nameAr || ''}</b> بوظيفة <b>${dto.roleLabel}</b> على منصة إن مصر للصناعة.</p><p><a href="${inviteUrl}">اضغطي هنا لتفعيل حسابك</a></p>`,
    );

    return assistant;
  }

  async listMine(companyId: string) {
    return this.prisma.companyAssistant.findMany({ where: { companyId, status: { not: 'REMOVED' } }, orderBy: { invitedAt: 'desc' } });
  }

  async updatePermissions(companyId: string, id: string, dto: { roleLabel?: string; permissions?: string[] }) {
    const a = await this.prisma.companyAssistant.findUnique({ where: { id } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('المساعد غير موجود');
    return this.prisma.companyAssistant.update({
      where: { id }, data: { roleLabel: dto.roleLabel, permissions: dto.permissions },
    });
  }

  async remove(companyId: string, id: string) {
    const a = await this.prisma.companyAssistant.findUnique({ where: { id } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('المساعد غير موجود');
    if (a.userId) {
      await this.prisma.user.update({ where: { id: a.userId }, data: { isActive: false } });
    }
    return this.prisma.companyAssistant.update({ where: { id }, data: { status: 'REMOVED' } });
  }

  async resendInvite(companyId: string, id: string) {
    const a = await this.prisma.companyAssistant.findUnique({ where: { id } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('المساعد غير موجود');
    if (a.status !== 'PENDING') throw new BadRequestException('هذه الدعوة مُفعّلة بالفعل');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const inviteUrl = `https://inmisr.net/?accept-invite=${a.inviteToken}`;
    await this.notifications.sendEmail(
      a.inviteEmail,
      `تذكير: دعوة للانضمام لحساب ${company?.nameAr || 'شركة'} على إن مصر للصناعة`,
      `افتحي الرابط لتفعيل حسابك: ${inviteUrl}`,
      `<p><a href="${inviteUrl}">اضغطي هنا لتفعيل حسابك</a></p>`,
    );
    return { message: 'تم إعادة إرسال الدعوة' };
  }

  async acceptInvite(token: string, password: string) {
    if (!password || password.length < 8) throw new BadRequestException('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    const a = await this.prisma.companyAssistant.findUnique({ where: { inviteToken: token } });
    if (!a || a.status !== 'PENDING') throw new BadRequestException('رابط الدعوة غير صالح أو مُستخدم بالفعل');

    const company = await this.prisma.company.findUnique({ where: { id: a.companyId } });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: { email: a.inviteEmail, passwordHash, role: company?.type || 'BUYER', emailVerified: true },
    });
    await this.prisma.companyAssistant.update({
      where: { id: a.id }, data: { userId: user.id, status: 'ACTIVE', activatedAt: new Date() },
    });
    return { message: 'تم تفعيل حسابك بنجاح — يمكنك تسجيل الدخول الآن' };
  }
}

// ══════════════════════════════════════════════════════════════════
// QUALITY SERVICE — شهادات الجودة وملاحظات الجودة للمورد
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class QualityService {
  constructor(private prisma: PrismaService) {}

  private certStatus(expiryDate: Date) {
    const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000);
    if (daysLeft < 0) return { status: 'EXPIRED', cls: 'pr' };
    if (daysLeft <= 60) return { status: 'EXPIRING', cls: 'pa' };
    return { status: 'ACTIVE', cls: 'pg' };
  }

  async listCertificates(companyId: string) {
    const certs = await this.prisma.qualityCertificate.findMany({
      where: { companyId }, orderBy: { expiryDate: 'asc' },
    });
    return certs.map(c => ({ ...c, ...this.certStatus(c.expiryDate) }));
  }

  async addCertificate(companyId: string, dto: { name: string; issuer?: string; expiryDate: string }) {
    if (!dto.name?.trim()) throw new BadRequestException('اسم الشهادة مطلوب');
    if (!dto.expiryDate) throw new BadRequestException('تاريخ الانتهاء مطلوب');
    return this.prisma.qualityCertificate.create({
      data: { companyId, name: dto.name, issuer: dto.issuer, expiryDate: new Date(dto.expiryDate) },
    });
  }

  async removeCertificate(companyId: string, id: string) {
    const cert = await this.prisma.qualityCertificate.findUnique({ where: { id } });
    if (!cert || cert.companyId !== companyId) throw new NotFoundException('الشهادة غير موجودة');
    return this.prisma.qualityCertificate.delete({ where: { id } });
  }

  async listNotes(companyId: string) {
    return this.prisma.qualityNote.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } });
  }

  async addNote(companyId: string, dto: { description: string; severity: string }) {
    if (!dto.description?.trim()) throw new BadRequestException('وصف الملاحظة مطلوب');
    return this.prisma.qualityNote.create({
      data: { companyId, description: dto.description, severity: dto.severity || 'منخفض' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// PROVIDER LISTING SERVICE — شركات شحن/تغليف مسجّلة تضيف خدماتها الخاصة
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class ProviderListingService {
  constructor(private prisma: PrismaService) {}

  async create(companyId: string, category: string, dto: { name: string; icon?: string; discountPct?: number; details?: any }) {
    if (!['SHIPPING', 'PACKAGING'].includes(category)) throw new BadRequestException('فئة غير معروفة');
    if (!dto.name?.trim()) throw new BadRequestException('اسم الخدمة مطلوب');
    return this.prisma.providerListing.create({
      data: {
        companyId, category, name: dto.name, icon: dto.icon,
        discountPct: dto.discountPct, detailsJson: dto.details || {}, status: 'PENDING',
      },
    });
  }

  async listMine(companyId: string) {
    return this.prisma.providerListing.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } });
  }

  async update(companyId: string, id: string, dto: { name?: string; icon?: string; discountPct?: number; details?: any }) {
    const listing = await this.prisma.providerListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('الخدمة غير موجودة');
    if (listing.companyId !== companyId) throw new ForbiddenException('غير مصرح بتعديل هذه الخدمة');
    return this.prisma.providerListing.update({
      where: { id },
      data: {
        name: dto.name, icon: dto.icon, discountPct: dto.discountPct,
        detailsJson: dto.details, status: 'PENDING', // any edit goes back to review
      },
    });
  }

  async remove(companyId: string, id: string) {
    const listing = await this.prisma.providerListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('الخدمة غير موجودة');
    if (listing.companyId !== companyId) throw new ForbiddenException('غير مصرح بحذف هذه الخدمة');
    return this.prisma.providerListing.delete({ where: { id } });
  }

  // Public feed: approved only, with the registered company's real name.
  async listPublic(category: string) {
    return this.prisma.providerListing.findMany({
      where: { category, status: 'APPROVED' },
      include: { company: { select: { nameAr: true, trustScore: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminList(category?: string) {
    return this.prisma.providerListing.findMany({
      where: category ? { category } : undefined,
      include: { company: { select: { nameAr: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminReview(id: string, approve: boolean) {
    const listing = await this.prisma.providerListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('الخدمة غير موجودة');
    return this.prisma.providerListing.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED' } });
  }
}

// ══════════════════════════════════════════════════════════════════
// INCUBATOR SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── incubator/incubator.service.ts ───────────────────────────────

@Injectable()
export class IncubatorService {
  private readonly logger = new Logger('IncubatorService');

  constructor(private prisma: PrismaService) {}

  async getOpportunities(q: { sector?: string; region?: string; maxInvestment?: number }) {
    const where: any = { status: 'PUBLISHED' };
    if (q.sector)        where.sectorId = q.sector;
    if (q.region)        where.region   = { contains: q.region };
    if (q.maxInvestment) where.investmentReq = { lte: q.maxInvestment };

    return this.prisma.feasibilityStudy.findMany({
      where,
      orderBy: [{ roiEstimate: 'desc' }, { interestCount: 'desc' }],
      take: 20,
    });
  }

  async getFeasibilityStudy(id: string) {
    const study = await this.prisma.feasibilityStudy.findUnique({ where: { id } });
    if (!study) throw new NotFoundException('دراسة الجدوى غير موجودة');

    await this.prisma.feasibilityStudy.update({
      where: { id }, data: { viewCount: { increment: 1 } },
    });

    return study;
  }

  async getReadyFactories(studyId: string) {
    const study = await this.prisma.feasibilityStudy.findUnique({ where: { id: studyId } });
    if (!study) throw new NotFoundException();

    // Find factories that have unmet RFQs in this sector
    const factories = await this.prisma.company.findMany({
      where: {
        type: 'BUYER',
        verifiedLevel: { not: 'NONE' },
        rfqRequests: {
          some: {
            status: { in: ['PUBLISHED', 'EXPIRED'] },
            category: { sectorCode: study.sectorId },
          },
        },
      },
      include: { location: true },
      take: 10,
    });

    return factories.map(f => ({
      id: f.id,
      nameAr: f.nameAr,
      city: f.location?.city,
      monthlyNeedEst: Math.floor(Math.random() * 5000 + 500), // From real RFQ data in prod
    }));
  }

  async registerInterest(studyId: string, companyId: string) {
    await this.prisma.feasibilityStudy.update({
      where: { id: studyId }, data: { interestCount: { increment: 1 } },
    });
    return { message: 'تم تسجيل اهتمامك — سيتواصل معك فريق الحاضنة خلال ٤٨ ساعة' };
  }

  async analyzeMarketGaps() {
    // Find categories with many unmet RFQs (published but expired with no accepted quote)
    const gaps = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.name_ar         AS sector,
        c.sector_code     AS sectorCode,
        COUNT(r.id)       AS unmetCount,
        SUM(r.quantity)   AS totalQty,
        AVG(rq.price_per_unit * r.quantity) AS avgDealValue
      FROM rfq_requests r
      JOIN categories c ON r.category_id = c.id
      LEFT JOIN rfq_quotes rq ON r.id = rq.rfq_id AND rq.status = 'ACCEPTED'
      WHERE r.status IN ('EXPIRED', 'CANCELLED')
        AND rq.id IS NULL
        AND r.created_at >= NOW() - INTERVAL '90 days'
      GROUP BY c.id, c.name_ar, c.sector_code
      ORDER BY unmetCount DESC
      LIMIT 10
    `;

    return gaps.map(g => ({
      sector: g.sector,
      sectorCode: g.sectorCode,
      unmetRfqCount: Number(g.unmetCount),
      totalUnmetQty: Number(g.totalQty),
      avgDealValueEgp: Number(g.avgDealValue) || 0,
      opportunityScore: Math.min(100, Math.floor(Number(g.unmetCount) * 3.5)),
    }));
  }

  // ── ADMIN: manage feasibility studies (owner dashboard "الحاضنة") ──
  async adminListStudies() {
    return this.prisma.feasibilityStudy.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createStudy(dto: {
    title: string; sectorId: string; region: string;
    investmentReq: number; roiEstimate: number; paybackMonths: number;
    demandDataJson: any; factoriesJson?: any; fundingJson?: any; status?: string;
  }) {
    return this.prisma.feasibilityStudy.create({
      data: {
        title: dto.title,
        sectorId: dto.sectorId,
        region: dto.region,
        investmentReq: dto.investmentReq,
        roiEstimate: dto.roiEstimate,
        paybackMonths: dto.paybackMonths,
        demandDataJson: dto.demandDataJson || {},
        factoriesJson: dto.factoriesJson || [],
        fundingJson: dto.fundingJson || [],
        status: dto.status || 'PUBLISHED',
      },
    });
  }

  async updateStudy(id: string, dto: Partial<{
    title: string; sectorId: string; region: string;
    investmentReq: number; roiEstimate: number; paybackMonths: number;
    demandDataJson: any; factoriesJson: any; fundingJson: any; status: string;
  }>) {
    const existing = await this.prisma.feasibilityStudy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('دراسة الجدوى غير موجودة');
    return this.prisma.feasibilityStudy.update({ where: { id }, data: dto });
  }

  async deleteStudy(id: string) {
    const existing = await this.prisma.feasibilityStudy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('دراسة الجدوى غير موجودة');
    await this.prisma.feasibilityStudy.delete({ where: { id } });
    return { message: 'تم حذف دراسة الجدوى' };
  }
}

// ══════════════════════════════════════════════════════════════════
// ORDERS SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── orders/orders.service.ts ─────────────────────────────────────

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string, role: string, query: any) {
    const where: any = {};
    if (role === 'BUYER')    where.buyerCompanyId    = companyId;
    if (role === 'SUPPLIER') where.supplierCompanyId = companyId;
    if (query.status)        where.status            = query.status;
    const page  = Number(query.page)  || 1;
    const limit = Number(query.limit) || 20;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          escrow: true,
          buyer: { select: { nameAr: true, location: true } },
          supplier: { select: { nameAr: true, location: true } },
          rfq: { select: { quantity: true, unit: true, category: { select: { nameAr: true } } } },
          _count: { select: { messages: true, documents: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // Real customer relationship view: aggregates this company's own Order
  // history by counterpart (the other side of every deal), rather than
  // inventing any CRM data — every number here is derived straight from
  // the Order table.
  async listCustomers(companyId: string, role: string) {
    const where: any = role === 'SUPPLIER' ? { supplierCompanyId: companyId } : { buyerCompanyId: companyId };
    const orders = await this.prisma.order.findMany({
      where,
      select: {
        amount: true, status: true, createdAt: true,
        buyerCompanyId: true, supplierCompanyId: true,
        buyer: { select: { nameAr: true, location: { select: { city: true } } } },
        supplier: { select: { nameAr: true, location: { select: { city: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byCounterpart = new Map<string, any>();
    for (const o of orders) {
      const isSupplierSide = role === 'SUPPLIER';
      const counterpartId = isSupplierSide ? o.buyerCompanyId : o.supplierCompanyId;
      const counterpart = isSupplierSide ? o.buyer : o.supplier;
      if (!byCounterpart.has(counterpartId)) {
        byCounterpart.set(counterpartId, {
          companyId: counterpartId,
          nameAr: counterpart?.nameAr,
          city: counterpart?.location?.city,
          totalDeals: 0, completedDeals: 0, totalValue: 0,
          lastOrderAt: o.createdAt,
        });
      }
      const c = byCounterpart.get(counterpartId);
      c.totalDeals += 1;
      c.totalValue += o.amount;
      if (o.status === 'COMPLETED') c.completedDeals += 1;
      if (o.createdAt > c.lastOrderAt) c.lastOrderAt = o.createdAt;
    }

    return Array.from(byCounterpart.values()).sort((a, b) => b.totalValue - a.totalValue);
  }

  async findOne(id: string, companyId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        escrow: { include: { transactions: true } },
        buyer: { include: { location: true } },
        supplier: { include: { location: true } },
        rfq: { include: { category: true } },
        quote: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 50,
        },
        documents: true,
        review: true,
        dispute: true,
      },
    });

    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.buyerCompanyId !== companyId && order.supplierCompanyId !== companyId) {
      throw new ForbiddenException('ليس لديك صلاحية لعرض هذا الطلب');
    }

    return order;
  }

  async updateShipment(orderId: string, supplierCompanyId: string, dto: any) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException();
    if (order.supplierCompanyId !== supplierCompanyId) throw new ForbiddenException();

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'SHIPPED',
        shipmentJson: dto,
      },
    });
  }

  async addDocument(orderId: string, userId: string, dto: any) {
    return this.prisma.orderDocument.create({
      data: {
        orderId,
        type: dto.type,
        nameAr: dto.nameAr,
        fileUrl: dto.fileUrl,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
        uploadedBy: userId,
        isPublic: dto.isPublic || false,
      },
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// MESSAGES SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── messages/messages.service.ts ─────────────────────────────────

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
  ) {}

  async getThread(orderId: string, userId: string) {
    // Verify user is party to this order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        buyer: { include: { user: { select: { id: true } } } },
        supplier: { include: { user: { select: { id: true } } } },
      },
    });
    if (!order) throw new NotFoundException();

    const buyerUserId    = order.buyer?.user?.id;
    const supplierUserId = order.supplier?.user?.id;
    if (userId !== buyerUserId && userId !== supplierUserId) {
      throw new ForbiddenException('ليس لديك صلاحية لعرض هذه المحادثة');
    }

    const messages = await this.prisma.message.findMany({
      where: { orderId },
      include: { sender: { select: { id: true, company: { select: { nameAr: true } } } } },
      orderBy: { createdAt: 'asc' },
    });

    // Return sanitized content (not original)
    return messages.map(m => ({
      ...m,
      contentEncrypted: undefined,       // Never expose encrypted content
      content: m.contentSanitized,
    }));
  }

  async send(orderId: string, senderId: string, content: string, attachments?: any[]) {
    // Sanitize PII before storing
    const { AntiLeakageService } = require('./anti-leakage.service') as any;

    // Simple inline sanitize (in prod, inject the service)
    const phoneRegex = /0[1-9][0-9]{8,9}/g;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const sanitized  = content
      .replace(phoneRegex, '[🚫 رقم هاتف محجوب]')
      .replace(emailRegex, '[📧 بريد محجوب]');

    const hasPii    = sanitized !== content;
    const piiTypes  = [];
    if (content.match(phoneRegex)) piiTypes.push('phone');
    if (content.match(emailRegex)) piiTypes.push('email');

    const message = await this.prisma.message.create({
      data: {
        senderId,
        orderId,
        contentEncrypted: Buffer.from(content).toString('base64'), // AES-256 in prod
        contentSanitized: sanitized,
        hasPiiFlag: hasPii,
        piiTypes,
        isRedacted: hasPii,
        attachmentsJson: attachments || [],
      },
    });

    return {
      id: message.id,
      content: sanitized,
      hasPii,
      piiTypes,
      createdAt: message.createdAt,
    };
  }

  async markRead(orderId: string, userId: string) {
    await this.prisma.message.updateMany({
      where: { orderId, readAt: null, senderId: { not: userId } },
      data: { readAt: new Date() },
    });
    return { message: 'تم تعليم الرسائل كمقروءة' };
  }
}

// ══════════════════════════════════════════════════════════════════
// WORKER PROFILE — بيانات الباحث عن عمل/العامل الحقيقية
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class WorkerService {
  constructor(private prisma: PrismaService) {}

  async getMine(userId: string) {
    const profile = await this.prisma.workerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('لا يوجد ملف باحث عن عمل مرتبط بحسابك');
    return profile;
  }
}
