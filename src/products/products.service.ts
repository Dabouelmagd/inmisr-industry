// ═══════════════════════════════════════════════════════════════════
// products/products.service.ts + reviews + categories + subscriptions
// ═══════════════════════════════════════════════════════════════════

import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, Logger,
} from '@nestjs/common';
import {
  Controller, Get, Post, Put, Delete, Patch,
  Body, Param, Query, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsEnum, Min, IsArray, IsObject, IsBoolean, IsUrl } from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtGuard } from '../auth/jwt.guard';

// ══════════════════════════════════════════════════════════════════
// PRODUCTS SERVICE
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: {
    companyId?: string; categoryId?: string; search?: string;
    minPrice?: number; maxPrice?: number; page?: number; limit?: number;
  }) {
    const where: any = { isActive: true, status: 'APPROVED' };
    if (query.companyId)  where.companyId  = query.companyId;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.search) {
      where.OR = [
        { nameAr: { contains: query.search, mode: 'insensitive' } },
        { nameEn: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.minPrice || query.maxPrice) {
      where.priceMin = {};
      if (query.minPrice) where.priceMin.gte = Number(query.minPrice);
      if (query.maxPrice) where.priceMin.lte = Number(query.maxPrice);
    }

    const page  = Number(query.page)  || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: { select: { nameAr: true, sectorCode: true } },
          company:  { select: { nameAr: true, verifiedLevel: true, trustScore: true, avgRating: true } },
        },
        orderBy: { views: 'desc' },
        skip, take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id, isActive: true },
      include: {
        category: true,
        company: {
          include: { location: true, subscription: true },
          select: {
            id: true, nameAr: true, verifiedLevel: true,
            trustScore: true, avgRating: true, totalDeals: true,
            avgResponseHours: true, location: true, subscription: true,
          } as any,
        },
      },
    });
    if (!product) throw new NotFoundException('المنتج غير موجود');

    // Increment view count
    await this.prisma.product.update({ where: { id }, data: { views: { increment: 1 } } });
    return product;
  }

  async create(companyId: string, dto: CreateProductDto) {
    // Check product limit based on subscription
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true, _count: { select: { products: true } } },
    });
    const limits: Record<string, number> = { FREE: 10, GROWTH: 200, ELITE: Infinity };
    const plan  = company?.subscription?.plan || 'FREE';
    const limit = limits[plan];
    const count = (company as any)?._count?.products || 0;
    if (count >= limit) {
      throw new ForbiddenException(`وصلت للحد الأقصى من المنتجات (${limit}) في خطتك. يرجى الترقية.`);
    }

    return this.prisma.product.create({
      data: { ...dto, companyId, status: 'PENDING' },
      include: { category: { select: { nameAr: true } } },
    });
  }

  async update(id: string, companyId: string, dto: Partial<CreateProductDto>) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    if (product.companyId !== companyId) throw new ForbiddenException();
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async remove(id: string, companyId: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    if (product.companyId !== companyId) throw new ForbiddenException();
    return this.prisma.product.update({ where: { id }, data: { isActive: false } });
  }

  // ── ADMIN: review queue (owner dashboard "المنتجات والخامات") ────
  async adminListPending() {
    return this.prisma.product.findMany({
      where: { status: 'PENDING' },
      include: {
        category: { select: { nameAr: true } },
        company: { select: { nameAr: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async adminReview(id: string, adminId: string, approve: boolean) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('المنتج غير موجود');
    if (product.status !== 'PENDING') throw new BadRequestException('تمت مراجعة هذا المنتج بالفعل');
    return this.prisma.product.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedBy: adminId, reviewedAt: new Date() },
    });
  }
}

class CreateProductDto {
  @IsString()   nameAr:      string;
  @IsString() @IsOptional()  nameEn?:     string;
  @IsString()   categoryId:  string;
  @IsObject()   specsJson:   Record<string, any>;
  @IsNumber() @IsOptional() @Min(0) priceMin?:   number;
  @IsNumber() @IsOptional() @Min(0) priceMax?:   number;
  @IsString()   unit:        string;
  @IsNumber() @Min(0)        minQty:      number;
  @IsNumber() @IsOptional()  maxQty?:     number;
  @IsArray()  @IsOptional()  imagesJson?: string[];
  @IsArray()  @IsOptional()  docsJson?:   string[];
}

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة المنتجات' })
  findAll(@Query() q: any) { return this.products.findAll(q); }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل منتج' })
  findOne(@Param('id') id: string) { return this.products.findOne(id); }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إضافة منتج جديد' })
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateProductDto, @Request() req: any) {
    return this.products.create(req.user.companyId, dto);
  }

  @Put(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تعديل منتج' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateProductDto>, @Request() req: any) {
    return this.products.update(id, req.user.companyId, dto);
  }

  @Delete(':id')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حذف منتج' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.products.remove(id, req.user.companyId);
  }

  // ── Admin: review queue (owner dashboard) ────────────────────────
  @Get('admin/pending')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'المنتجات المعلّقة للمراجعة (أدمن)' })
  adminPending(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.products.adminListPending();
  }

  @Post(':id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على منتج أو رفضه (أدمن)' })
  review(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.products.adminReview(id, req.user.sub, !!body.approve);
  }
}

// ══════════════════════════════════════════════════════════════════
// REVIEWS SERVICE
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
  ) {}

  async createReview(orderId: string, reviewerId: string, dto: CreateReviewDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        buyer:    { include: { user: true } },
        supplier: { include: { user: true } },
        review:   true,
      },
    });
    if (!order)  throw new NotFoundException('الطلب غير موجود');
    if (order.review) throw new BadRequestException('تم تقييم هذا الطلب مسبقاً');
    if (!['CONFIRMED', 'COMPLETED'].includes(order.status)) {
      throw new BadRequestException('لا يمكن تقييم طلب غير مكتمل');
    }

    const isReviewer = order.buyer?.user?.id === reviewerId;
    if (!isReviewer) throw new ForbiddenException('فقط المشتري يمكنه تقييم الطلب');

    const overallScore = (dto.qualityScore + dto.timeScore + dto.commScore) / 3;

    const review = await this.prisma.review.create({
      data: {
        orderId,
        reviewerId: order.buyerCompanyId,
        revieweeId: order.supplierCompanyId,
        qualityScore: dto.qualityScore,
        timeScore:    dto.timeScore,
        commScore:    dto.commScore,
        overallScore: +overallScore.toFixed(2),
        comment:      dto.comment,
        isPublic:     dto.isPublic ?? true,
      },
    });

    // Recalculate supplier average rating
    const allReviews = await this.prisma.review.findMany({
      where: { revieweeId: order.supplierCompanyId },
    });
    const avgRating = allReviews.reduce((s, r) => s + r.overallScore, 0) / allReviews.length;
    await this.prisma.company.update({
      where: { id: order.supplierCompanyId },
      data:  { avgRating: +avgRating.toFixed(2), totalReviews: allReviews.length },
    });

    // Notify supplier
    const supplierUser = order.supplier?.user;
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id, 'REVIEW_RECEIVED',
        `تقييم جديد — ${overallScore.toFixed(1)} نجوم`,
        dto.comment?.slice(0, 100) || 'شكراً على التعامل الممتاز',
        { orderId, rating: overallScore },
      );
    }

    this.logger.log(`Review created: order ${orderId}, score ${overallScore.toFixed(1)}`);
    return review;
  }

  async getCompanyReviews(companyId: string, query: { page?: number; limit?: number; minRating?: number }) {
    const where: any = { revieweeId: companyId, isPublic: true };
    if (query.minRating) where.overallScore = { gte: Number(query.minRating) };
    const page  = Number(query.page)  || 1;
    const limit = Number(query.limit) || 10;

    const [data, total, avg] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: { reviewer: { select: { nameAr: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.aggregate({ where, _avg: { overallScore: true, qualityScore: true, timeScore: true, commScore: true } }),
    ]);

    return {
      data, total,
      averages: {
        overall: +(avg._avg.overallScore || 0).toFixed(2),
        quality: +(avg._avg.qualityScore || 0).toFixed(2),
        time:    +(avg._avg.timeScore    || 0).toFixed(2),
        comm:    +(avg._avg.commScore    || 0).toFixed(2),
      },
      page, totalPages: Math.ceil(total / limit),
    };
  }
}

class CreateReviewDto {
  @IsNumber() @Min(1) qualityScore: number;
  @IsNumber() @Min(1) timeScore:    number;
  @IsNumber() @Min(1) commScore:    number;
  @IsString() @IsOptional() comment?: string;
  @IsBoolean() @IsOptional() isPublic?: boolean;
}

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private reviews: ReviewsService) {}

  @Post('orders/:orderId')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تقييم طلب مكتمل' })
  create(@Param('orderId') orderId: string, @Body() dto: CreateReviewDto, @Request() req: any) {
    return this.reviews.createReview(orderId, req.user.sub, dto);
  }

  @Get('companies/:companyId')
  @ApiOperation({ summary: 'تقييمات مورد' })
  getCompanyReviews(@Param('companyId') companyId: string, @Query() q: any) {
    return this.reviews.getCompanyReviews(companyId, q);
  }
}

// ══════════════════════════════════════════════════════════════════
// CATEGORIES SERVICE
// ══════════════════════════════════════════════════════════════════

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeTemplate = false) {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true, parentId: null },
      include: {
        children: { where: { isActive: true } },
        _count: { select: { products: true, rfqRequests: true, companies: true } },
      },
      orderBy: { nameAr: 'asc' },
    });

    return categories.map(cat => ({
      ...cat,
      rfqTemplateJson: includeTemplate ? cat.rfqTemplateJson : undefined,
      stats: {
        products:   (cat as any)._count.products,
        rfqs:       (cat as any)._count.rfqRequests,
        suppliers:  (cat as any)._count.companies,
      },
    }));
  }

  async findOne(id: string) {
    const cat = await this.prisma.category.findUnique({
      where: { id, isActive: true },
      include: {
        _count: { select: { products: true, rfqRequests: true, companies: true } },
      },
    });
    if (!cat) throw new NotFoundException('القطاع غير موجود');
    return cat;
  }

  async getRfqTemplate(sectorCode: string) {
    const cat = await this.prisma.category.findUnique({ where: { sectorCode } });
    if (!cat) throw new NotFoundException('قالب القطاع غير موجود');
    return { sectorCode, nameAr: cat.nameAr, template: cat.rfqTemplateJson };
  }

  async getSectorStats() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      include: { _count: { select: { products: true, rfqRequests: true, companies: true } } },
      orderBy: { nameAr: 'asc' },
    });
  }
}

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private categories: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'الـ٢٨ قطاع الصناعي' })
  findAll(@Query('template') template?: string) {
    return this.categories.findAll(template === 'true');
  }

  @Get('stats')
  @ApiOperation({ summary: 'إحصائيات القطاعات' })
  getStats() { return this.categories.getSectorStats(); }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل قطاع' })
  findOne(@Param('id') id: string) { return this.categories.findOne(id); }

  @Get('rfq-template/:sectorCode')
  @ApiOperation({ summary: 'قالب RFQ لقطاع محدد' })
  getRfqTemplate(@Param('sectorCode') code: string) { return this.categories.getRfqTemplate(code); }
}

// ══════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS SERVICE
// ══════════════════════════════════════════════════════════════════

const PLAN_PRICING: Record<string, { monthly: number; annual: number; features: string[] }> = {
  FREE:   { monthly: 0,    annual: 0,     features: ['١٠ منتجات', '٥ ردود RFQ/شهر', 'شارة موثق', 'عمولة ٣.٥٪'] },
  GROWTH: { monthly: 1500, annual: 15000, features: ['٢٠٠ منتج', '٥٠ رداً/شهر', 'تحليلات', 'إعلانات', 'عمولة ٢.٥٪'] },
  ELITE:  { monthly: 4500, annual: 45000, features: ['غير محدود', 'مدير حساب', 'أولوية ×٥', 'عمولة ١.٥٪'] },
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private prisma:        PrismaService,
    private notifications: NotificationsService,
  ) {}

  getPlans() {
    return Object.entries(PLAN_PRICING).map(([plan, info]) => ({ plan, ...info }));
  }

  async getMySubscription(companyId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { companyId },
    });
    if (!sub) return { plan: 'FREE', features: PLAN_PRICING.FREE.features };

    const daysLeft = sub.endDate
      ? Math.max(0, Math.ceil((sub.endDate.getTime() - Date.now()) / 86400000))
      : null;

    return { ...sub, daysLeft, pricing: PLAN_PRICING[sub.plan] };
  }

  async upgrade(companyId: string, dto: { plan: 'FREE' | 'GROWTH' | 'ELITE'; billing: 'monthly' | 'annual' }) {
    if (dto.plan === 'FREE') throw new BadRequestException('لا يمكن الترقية إلى الخطة المجانية');

    const pricing = PLAN_PRICING[dto.plan];
    const amount  = dto.billing === 'annual' ? pricing.annual : pricing.monthly;
    const months  = dto.billing === 'annual' ? 12 : 1;
    const endDate = new Date(Date.now() + months * 30 * 86400000);

    const sub = await this.prisma.subscription.upsert({
      where: { companyId },
      create: { companyId, plan: dto.plan, endDate, autoRenew: true },
      update: { plan: dto.plan, endDate, autoRenew: true },
    });

    const user = await this.prisma.user.findFirst({ where: { company: { id: companyId } } });
    if (user) {
      await this.notifications.send(user.id, 'SYSTEM',
        `تم ترقية اشتراكك إلى ${dto.plan}`,
        `الاشتراك صالح حتى ${endDate.toLocaleDateString('ar-EG')}. استمتع بجميع المزايا!`,
        { plan: dto.plan, endDate },
      );
    }

    this.logger.log(`Subscription upgraded: company ${companyId} → ${dto.plan} (${dto.billing})`);
    return { sub, amount, endDate, message: 'سيتم تفعيل الاشتراك فور إتمام الدفع' };
  }

  async cancel(companyId: string) {
    await this.prisma.subscription.update({
      where: { companyId },
      data: { autoRenew: false, cancelledAt: new Date() },
    });
    return { message: 'تم إلغاء التجديد التلقائي — اشتراكك يبقى نشطاً حتى تاريخ انتهائه' };
  }

  async checkExpiredSubscriptions() {
    const expired = await this.prisma.subscription.updateMany({
      where: {
        plan: { not: 'FREE' },
        endDate: { lte: new Date() },
        autoRenew: false,
      },
      data: { plan: 'FREE' },
    });
    if (expired.count > 0) this.logger.log(`Downgraded ${expired.count} expired subscriptions to FREE`);
    return expired.count;
  }
}

class UpgradeDto {
  @IsEnum(['GROWTH', 'ELITE']) plan: 'GROWTH' | 'ELITE';
  @IsEnum(['monthly', 'annual']) billing: 'monthly' | 'annual';
}

@ApiTags('subscriptions')
@Controller('subscriptions')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class SubscriptionsController {
  constructor(private subscriptions: SubscriptionsService) {}

  @Get('plans')
  @ApiOperation({ summary: 'خطط الاشتراك المتاحة' })
  getPlans() { return this.subscriptions.getPlans(); }

  @Get('my')
  @ApiOperation({ summary: 'اشتراكي الحالي' })
  getMy(@Request() req: any) { return this.subscriptions.getMySubscription(req.user.companyId); }

  @Post('upgrade')
  @ApiOperation({ summary: 'ترقية الاشتراك' })
  upgrade(@Body() dto: UpgradeDto, @Request() req: any) {
    return this.subscriptions.upgrade(req.user.companyId, dto);
  }

  @Post('cancel')
  @ApiOperation({ summary: 'إلغاء التجديد التلقائي' })
  cancel(@Request() req: any) { return this.subscriptions.cancel(req.user.companyId); }
}
