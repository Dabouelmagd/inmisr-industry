// ─── rfq/rfq.service.ts ───────────────────────────────────────────
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AntiLeakageService } from '../common/anti-leakage.service';
import { EscrowService } from '../escrow/escrow.service';
import { RfqStatus, SubscriptionPlan } from '@prisma/client';

const PLAN_LIMITS: Record<SubscriptionPlan, number> = {
  FREE: 5, GROWTH: 50, ELITE: Infinity,
};

@Injectable()
export class RfqService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private antiLeakage: AntiLeakageService,
    private escrow: EscrowService,
  ) {}

  // ── CREATE RFQ ────────────────────────────────────────────────
  async create(buyerCompanyId: string, dto: CreateRfqDto) {
    const category = await this.prisma.category.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) throw new NotFoundException('القطاع الصناعي غير موجود');

    const rfq = await this.prisma.rfqRequest.create({
      data: {
        buyerCompanyId,
        categoryId: dto.categoryId,
        templateType: dto.templateType || 'general',
        specsJson: dto.specsJson,
        quantity: dto.quantity,
        unit: dto.unit,
        deadline: new Date(dto.deadline),
        deliveryAddress: dto.deliveryAddress,
        deliveryCity: dto.deliveryCity,
        deliveryZone: dto.deliveryZone,
        paymentMethod: dto.paymentMethod,
        docsRequired: dto.docsRequired || [],
        acceptancePolicy: dto.acceptancePolicy,
        notes: dto.notes,
        geoRadiusKm: dto.geoRadiusKm || 100,
        status: dto.publish ? RfqStatus.PUBLISHED : RfqStatus.DRAFT,
        publishedAt: dto.publish ? new Date() : null,
        expiresAt: dto.publish
          ? new Date(Date.now() + (dto.validityDays || 7) * 86400000)
          : null,
      },
      include: { category: true, buyer: true },
    });

    if (dto.publish) {
      await this.notifyMatchingSuppliers(rfq);
    }

    return rfq;
  }

  // ── PUBLISH DRAFT ─────────────────────────────────────────────
  async publish(rfqId: string, buyerCompanyId: string) {
    const rfq = await this.findOneOrFail(rfqId);
    if (rfq.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();
    if (rfq.status !== RfqStatus.DRAFT) throw new BadRequestException('الطلب ليس في حالة مسودة');

    const updated = await this.prisma.rfqRequest.update({
      where: { id: rfqId },
      data: {
        status: RfqStatus.PUBLISHED,
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
      include: { category: true, buyer: true },
    });

    await this.notifyMatchingSuppliers(updated);
    return updated;
  }

  // ── SUBMIT QUOTE ──────────────────────────────────────────────
  async submitQuote(rfqId: string, supplierCompanyId: string, dto: CreateQuoteDto) {
    const rfq = await this.findOneOrFail(rfqId);
    if (rfq.status !== RfqStatus.PUBLISHED && rfq.status !== RfqStatus.QUOTES_RECEIVED) {
      throw new BadRequestException('الطلب لا يقبل عروضاً حالياً');
    }

    // Check subscription quote limit
    const supplier = await this.prisma.company.findUnique({
      where: { id: supplierCompanyId },
      include: { subscription: true },
    });
    const plan = supplier?.subscription?.plan || SubscriptionPlan.FREE;
    const limit = PLAN_LIMITS[plan];

    const thisMonthQuotes = await this.prisma.rfqQuote.count({
      where: {
        supplierCompanyId,
        createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      },
    });
    if (thisMonthQuotes >= limit) {
      throw new ForbiddenException(`وصلت للحد الأقصى لعدد العروض في خطتك (${limit}/شهر). يرجى ترقية الاشتراك.`);
    }

    const quote = await this.prisma.rfqQuote.upsert({
      where: { rfqId_supplierCompanyId: { rfqId, supplierCompanyId } },
      create: {
        rfqId,
        supplierCompanyId,
        pricePerUnit: dto.pricePerUnit,
        totalPrice: dto.pricePerUnit * rfq.quantity,
        deliveryDays: dto.deliveryDays,
        warrantyDays: dto.warrantyDays,
        paymentTerms: dto.paymentTerms,
        notes: dto.notes,
        documentsJson: dto.documentsJson || [],
        validUntil: new Date(Date.now() + (dto.validDays || 7) * 86400000),
      },
      update: {
        pricePerUnit: dto.pricePerUnit,
        totalPrice: dto.pricePerUnit * rfq.quantity,
        deliveryDays: dto.deliveryDays,
        warrantyDays: dto.warrantyDays,
        paymentTerms: dto.paymentTerms,
        notes: dto.notes,
      },
    });

    // Update RFQ status
    if (rfq.status === RfqStatus.PUBLISHED) {
      await this.prisma.rfqRequest.update({
        where: { id: rfqId },
        data: { status: RfqStatus.QUOTES_RECEIVED },
      });
    }

    // Notify buyer
    const buyerUser = await this.prisma.user.findFirst({
      where: { company: { id: rfq.buyerCompanyId } },
    });
    if (buyerUser) {
      await this.notifications.send(
        buyerUser.id, 'RFQ_QUOTE_RECEIVED',
        'عرض سعر جديد',
        `استلمت عرض سعر لطلب #${rfqId.slice(-6).toUpperCase()}`,
        { rfqId, quoteId: quote.id },
      );
    }

    return quote;
  }

  // ── ACCEPT QUOTE ──────────────────────────────────────────────
  async acceptQuote(rfqId: string, quoteId: string, buyerCompanyId: string) {
    const rfq = await this.findOneOrFail(rfqId);
    if (rfq.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();

    const quote = await this.prisma.rfqQuote.findUniqueOrThrow({ where: { id: quoteId } });

    // Compute commission based on deal size
    const commission = this.computeCommission(quote.totalPrice);
    const netToSupplier = quote.totalPrice - commission;

    // Create order
    const order = await this.prisma.order.create({
      data: {
        rfqId,
        quoteId,
        buyerCompanyId,
        supplierCompanyId: quote.supplierCompanyId,
        amount: quote.totalPrice,
        commission,
        netToSupplier,
        status: 'PENDING',
        paymentMethod: rfq.paymentMethod,
        escrow: { create: { amount: quote.totalPrice, commission, netToSupplier } },
      },
      include: { escrow: true, buyer: true, supplier: true },
    });

    // Update statuses
    await Promise.all([
      this.prisma.rfqRequest.update({ where: { id: rfqId }, data: { status: RfqStatus.ACCEPTED } }),
      this.prisma.rfqQuote.update({ where: { id: quoteId }, data: { status: 'ACCEPTED' } }),
    ]);

    // Notify supplier
    const supplierUser = await this.prisma.user.findFirst({
      where: { company: { id: quote.supplierCompanyId } },
    });
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id, 'RFQ_ACCEPTED',
        'تم قبول عرضك!',
        `قبل المشتري عرضك على طلب #${rfqId.slice(-6).toUpperCase()} — قيمة الطلب: ${quote.totalPrice.toLocaleString()} ج.م`,
        { rfqId, orderId: order.id },
      );
    }

    return order;
  }

  // ── SEARCH RFQs ───────────────────────────────────────────────
  async findAll(query: RfqQueryDto) {
    const page  = Number(query.page)  || 1;
    const limit = Number(query.limit) || 20;
    const where: any = { status: RfqStatus.PUBLISHED };
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.city) where.deliveryCity = { contains: query.city };
    if (query.minQty) where.quantity = { gte: Number(query.minQty) };

    const [data, total] = await Promise.all([
      this.prisma.rfqRequest.findMany({
        where,
        include: {
          category: true,
          buyer: { include: { location: true } },
          quotes: { select: { id: true, supplierCompanyId: true } },
        },
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.rfqRequest.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private computeCommission(amount: number): number {
    if (amount < 50000) return amount * 0.035;
    if (amount < 200000) return amount * 0.025;
    if (amount < 1000000) return amount * 0.0175;
    return amount * 0.01;
  }

  private async notifyMatchingSuppliers(rfq: any) {
    const suppliers = await this.prisma.company.findMany({
      where: {
        type: 'SUPPLIER',
        verifiedLevel: { not: 'NONE' },
        categories: { some: { categoryId: rfq.categoryId } },
      },
      include: { user: true, location: true },
      take: 50,
    });

    for (const supplier of suppliers) {
      if (supplier.user) {
        await this.notifications.send(
          supplier.user.id, 'RFQ_NEW',
          'طلب RFQ جديد يناسب منتجاتك',
          `طلب ${rfq.quantity} ${rfq.unit} في قطاع ${rfq.category?.nameAr} — ينتهي خلال ٧ أيام`,
          { rfqId: rfq.id },
        );
      }
    }
  }

  private async findOneOrFail(id: string) {
    const rfq = await this.prisma.rfqRequest.findUnique({ where: { id } });
    if (!rfq) throw new NotFoundException('طلب عرض السعر غير موجود');
    return rfq;
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────
import {
  IsString, IsNumber, IsOptional, IsEnum, IsBoolean,
  IsArray, IsObject, Min, IsUUID, IsDateString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';

export class CreateRfqDto {
  @IsUUID() categoryId: string;
  @IsString() @IsOptional() templateType?: string;
  @IsObject() specsJson: Record<string, any>;
  @IsNumber() @Min(0.01) quantity: number;
  @IsString() unit: string;
  @IsDateString() deadline: string;
  @IsString() deliveryAddress: string;
  @IsString() deliveryCity: string;
  @IsString() @IsOptional() deliveryZone?: string;
  @IsEnum(PaymentMethod) paymentMethod: PaymentMethod;
  @IsArray() @IsOptional() docsRequired?: string[];
  @IsString() @IsOptional() acceptancePolicy?: string;
  @IsString() @IsOptional() notes?: string;
  @IsNumber() @IsOptional() geoRadiusKm?: number;
  @IsBoolean() @IsOptional() publish?: boolean;
  @IsNumber() @IsOptional() validityDays?: number;
}

export class CreateQuoteDto {
  @IsNumber() @Min(0) pricePerUnit: number;
  @IsNumber() @Min(1) deliveryDays: number;
  @IsNumber() @IsOptional() warrantyDays?: number;
  @IsString() paymentTerms: string;
  @IsString() @IsOptional() notes?: string;
  @IsArray() @IsOptional() documentsJson?: any[];
  @IsNumber() @IsOptional() validDays?: number;
}

export class RfqQueryDto {
  @IsUUID() @IsOptional() categoryId?: string;
  @IsString() @IsOptional() city?: string;
  @IsNumber() @IsOptional() minQty?: number;
  @IsNumber() @IsOptional() page?: number;
  @IsNumber() @IsOptional() limit?: number;
}
