// ═══════════════════════════════════════════════════════════════════
// services/remaining.ts — Geo + Finance + Incubator + Orders + Messages
// ═══════════════════════════════════════════════════════════════════

import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// ══════════════════════════════════════════════════════════════════
// GEO SERVICE
// ══════════════════════════════════════════════════════════════════
// ─── geo/geo.service.ts ───────────────────────────────────────────

@Injectable()
export class GeoService {
  private readonly logger = new Logger('GeoService');

  private readonly INDUSTRIAL_ZONES = [
    { id: '10th',      nameAr: 'العاشر من رمضان', lat: 30.294, lng: 31.743, suppliersCount: 312, sectors: ['iron', 'chemicals', 'food'] },
    { id: '6oct',      nameAr: '٦ أكتوبر',         lat: 29.970, lng: 30.930, suppliersCount: 287, sectors: ['petrochemicals', 'textile', 'aluminum'] },
    { id: 'obour',     nameAr: 'مدينة العبور',     lat: 30.249, lng: 31.818, suppliersCount: 198, sectors: ['food', 'pharma', 'packaging'] },
    { id: 'sadat',     nameAr: 'مدينة السادات',    lat: 30.369, lng: 30.528, suppliersCount: 156, sectors: ['furniture', 'textile', 'ceramics'] },
    { id: 'borg',      nameAr: 'برج العرب',         lat: 30.898, lng: 29.547, suppliersCount: 201, sectors: ['iron', 'chemicals', 'logistics'] },
    { id: 'imbaba',    nameAr: 'إمبابة',            lat: 30.067, lng: 31.205, suppliersCount: 134, sectors: ['metals', 'mechanics', 'tools'] },
    { id: 'badr',      nameAr: 'مدينة بدر',         lat: 30.121, lng: 31.745, suppliersCount: 89,  sectors: ['electronics', 'solar', 'cables'] },
    { id: 'shorouk',   nameAr: 'مدينة الشروق',     lat: 30.157, lng: 31.614, suppliersCount: 76,  sectors: ['pharma', 'food', 'cosmetics'] },
  ];

  // Shipping partners pricing (EGP per ton per km)
  private readonly SHIPPING_RATE = 15; // EGP / ton / km

  constructor(private prisma: PrismaService) {}

  async getMapData(query: { lat?: number; lng?: number; radiusKm?: number; sector?: string }) {
    const where: any = { company: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } } };

    if (query.sector) {
      where.company = {
        ...where.company,
        categories: { some: { category: { sectorCode: query.sector } } },
      };
    }

    const locations = await this.prisma.geoLocation.findMany({
      where,
      include: {
        company: {
          select: {
            id: true, nameAr: true, nameEn: true,
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

  getIndustrialZones() {
    return this.INDUSTRIAL_ZONES;
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

@Injectable()
export class FactoryNeedService {
  constructor(private prisma: PrismaService) {}

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

  async submit(dto: { name: string; phone: string; governorate?: string; appliedFor: string; type: string }) {
    if (!dto.name?.trim() || !dto.phone?.trim()) {
      throw new BadRequestException('الاسم ورقم التليفون مطلوبان');
    }
    return this.prisma.tradeApplication.create({
      data: {
        name: dto.name, phone: dto.phone, governorate: dto.governorate,
        appliedFor: dto.appliedFor, type: dto.type, contacted: false,
      },
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

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          escrow: true,
          buyer: { select: { nameAr: true, location: true } },
          supplier: { select: { nameAr: true, location: true } },
          rfq: { select: { categoryId: true, quantity: true, unit: true } },
          _count: { select: { messages: true, documents: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: ((query.page || 1) - 1) * 20,
        take: 20,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, total, page: query.page || 1, totalPages: Math.ceil(total / 20) };
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
