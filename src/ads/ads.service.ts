// ─── ads/ads.service.ts ───────────────────────────────────────────
// نظام الإعلانات الممولة — Sponsored listings + CPC/CPM tracking
// موردو GROWTH/ELITE يمكنهم ترقية ظهورهم في نتائج البحث

import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtGuard } from '../auth/jwt.guard';

export type AdType     = 'SEARCH_TOP' | 'HOMEPAGE_BANNER' | 'CATEGORY_FEATURED' | 'RFQ_SIDEBAR';
export type BidModel   = 'CPC' | 'CPM' | 'FIXED';
export type AdStatus   = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REJECTED';

interface AdCampaign {
  id:           string;
  companyId:    string;
  name:         string;
  type:         AdType;
  bidModel:     BidModel;
  bidAmount:    number;   // EGP per click (CPC) or per 1000 impressions (CPM)
  dailyBudget:  number;   // Max daily spend
  totalBudget:  number;
  startDate:    Date;
  endDate:      Date;
  status:       AdStatus;
  targetSectors?: string[];
  targetCities?:  string[];
  creativeJson: {
    headline:     string;  // max 60 chars
    description:  string;  // max 150 chars
    imageUrl?:    string;
    ctaText:      string;
    destinationUrl: string;
  };
  stats: {
    impressions: number;
    clicks:      number;
    spent:       number;
    ctr:         number; // click-through rate
    conversions: number; // RFQs created after click
  };
}

@Injectable()
export class AdsService {
  private readonly logger = new Logger(AdsService.name);

  constructor(private prisma: PrismaService) {}

  // Real DB rows (impressions/clicks/spent/conversions as flat columns) ->
  // the same nested AdCampaign shape every existing caller already expects.
  private toApiShape(c: any): AdCampaign {
    return {
      id: c.id, companyId: c.companyId, name: c.name, type: c.type,
      bidModel: c.bidModel, bidAmount: c.bidAmount, dailyBudget: c.dailyBudget,
      totalBudget: c.totalBudget, startDate: c.startDate, endDate: c.endDate,
      status: c.status,
      targetSectors: (c.targetSectors as any) || [],
      targetCities: (c.targetCities as any) || [],
      creativeJson: c.creativeJson,
      stats: {
        impressions: c.impressions,
        clicks: c.clicks,
        spent: c.spent,
        ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
        conversions: c.conversions,
      },
    };
  }

  // ── CREATE CAMPAIGN ───────────────────────────────────────────
  async createCampaign(companyId: string, dto: CreateCampaignDto): Promise<AdCampaign> {
    // Validate company has GROWTH or ELITE plan
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true },
    });
    if (!company?.subscription || company.subscription.plan === 'FREE') {
      throw new BadRequestException('الإعلانات متاحة فقط لخطتي GROWTH وELITE');
    }

    const created = await this.prisma.adCampaign.create({
      data: {
        companyId,
        name:         dto.name,
        type:         dto.type,
        bidModel:     dto.bidModel,
        bidAmount:    dto.bidAmount,
        dailyBudget:  dto.dailyBudget,
        totalBudget:  dto.totalBudget,
        startDate:    new Date(dto.startDate),
        endDate:      new Date(dto.endDate),
        status:       'PENDING',
        targetSectors: dto.targetSectors || [],
        targetCities:  dto.targetCities || [],
        creativeJson:  dto.creative as any,
      },
    });

    this.logger.log(`Campaign created: ${created.id} by company ${companyId}`);
    return this.toApiShape(created);
  }

  // ── GET SPONSORED ADS for a context ──────────────────────────
  async getAds(context: {
    type:    AdType;
    sector?: string;
    city?:   string;
    limit?:  number;
  }): Promise<AdCampaign[]> {
    const now = new Date();
    let campaigns = await this.prisma.adCampaign.findMany({
      where: { status: 'ACTIVE', type: context.type, startDate: { lte: now }, endDate: { gte: now } },
      orderBy: { bidAmount: 'desc' },
    });

    campaigns = campaigns.filter(c => c.spent < c.totalBudget);
    if (context.sector) {
      campaigns = campaigns.filter(c => {
        const sectors = c.targetSectors as any;
        return !sectors?.length || sectors.includes(context.sector as string);
      });
    }
    if (context.city) {
      campaigns = campaigns.filter(c => {
        const cities = c.targetCities as any;
        return !cities?.length || cities.includes(context.city as string);
      });
    }

    return campaigns.slice(0, context.limit || 3).map(c => this.toApiShape(c));
  }

  // ── RECORD IMPRESSION ────────────────────────────────────────
  async recordImpression(campaignId: string, sessionId: string) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return;

    const data: any = { impressions: { increment: 1 } };
    if (campaign.bidModel === 'CPM') data.spent = { increment: campaign.bidAmount / 1000 };

    const updated = await this.prisma.adCampaign.update({ where: { id: campaignId }, data });
    await this.checkDailyBudget(updated);
  }

  // ── RECORD CLICK ─────────────────────────────────────────────
  async recordClick(campaignId: string, userId?: string): Promise<{ allowed: boolean; url: string }> {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== 'ACTIVE') return { allowed: false, url: '' };

    const data: any = { clicks: { increment: 1 } };
    if (campaign.bidModel === 'CPC') data.spent = { increment: campaign.bidAmount };

    const updated = await this.prisma.adCampaign.update({ where: { id: campaignId }, data });
    await this.checkDailyBudget(updated);

    this.logger.log(`Ad click: ${campaignId}, total clicks: ${updated.clicks}, spent: ${updated.spent}`);
    return { allowed: true, url: (campaign.creativeJson as any).destinationUrl };
  }

  // ── RECORD CONVERSION (RFQ created) ──────────────────────────
  async recordConversion(campaignId: string) {
    await this.prisma.adCampaign.update({
      where: { id: campaignId },
      data: { conversions: { increment: 1 } },
    }).catch(() => { /* campaign may not exist — ignore, matches old no-op behavior */ });
  }

  // ── CAMPAIGN ANALYTICS ────────────────────────────────────────
  async getCampaignStats(companyId: string) {
    const companyCampaigns = await this.prisma.adCampaign.findMany({ where: { companyId } });

    const total = companyCampaigns.reduce((acc, c) => ({
      impressions: acc.impressions + c.impressions,
      clicks:      acc.clicks      + c.clicks,
      spent:       acc.spent       + c.spent,
      conversions: acc.conversions + c.conversions,
    }), { impressions: 0, clicks: 0, spent: 0, conversions: 0 });

    return {
      campaigns: companyCampaigns.map(c => this.toApiShape(c)),
      totals: {
        ...total,
        avgCtr: total.impressions > 0 ? (total.clicks / total.impressions) * 100 : 0,
        costPerConversion: total.conversions > 0 ? total.spent / total.conversions : 0,
        roi: total.spent > 0 ? (total.conversions * 500) / total.spent : 0, // Estimated ROI
      },
    };
  }

  async pauseCampaign(id: string, companyId: string) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException();
    if (campaign.companyId !== companyId) throw new BadRequestException('Forbidden');
    const updated = await this.prisma.adCampaign.update({ where: { id }, data: { status: 'PAUSED' } });
    return this.toApiShape(updated);
  }

  async resumeCampaign(id: string, companyId: string) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException();
    if (campaign.companyId !== companyId) throw new BadRequestException('Forbidden');
    const updated = await this.prisma.adCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    return this.toApiShape(updated);
  }

  private async checkDailyBudget(campaign: any) {
    // Simple total-budget check — in production: track per-day spend separately
    if (campaign.spent >= campaign.totalBudget && campaign.status === 'ACTIVE') {
      await this.prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });
      this.logger.log(`Campaign ${campaign.id} budget exhausted — paused`);
    }
  }

  // ── ADMIN: approval queue (owner dashboard "الإعلانات") ───────
  async getPendingCampaigns() {
    const campaigns = await this.prisma.adCampaign.findMany({
      where: { status: 'PENDING' },
      include: { company: { select: { nameAr: true, nameEn: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return campaigns.map(c => Object.assign(this.toApiShape(c), { companyName: c.company?.nameAr }));
  }

  async reviewCampaign(id: string, approve: boolean) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException();
    if (campaign.status !== 'PENDING') throw new BadRequestException('الحملة تمت مراجعتها بالفعل');
    const updated = await this.prisma.adCampaign.update({
      where: { id },
      data: { status: approve ? 'ACTIVE' : 'REJECTED' },
    });
    return this.toApiShape(updated);
  }
}

// ─── ads/ads.controller.ts ────────────────────────────────────────
class CreateCampaignDto {
  name: string;
  type: AdType;
  bidModel: BidModel;
  bidAmount: number;
  dailyBudget: number;
  totalBudget: number;
  startDate: string;
  endDate: string;
  targetSectors?: string[];
  targetCities?: string[];
  creative: {
    headline: string;
    description: string;
    imageUrl?: string;
    ctaText: string;
    destinationUrl: string;
  };
}

@ApiTags('ads')
@Controller('ads')
export class AdsController {
  constructor(private ads: AdsService) {}

  @Get()
  @ApiOperation({ summary: 'استرجاع إعلانات ممولة لسياق معين' })
  getAds(@Query() q: { type: AdType; sector?: string; city?: string; limit?: number }) {
    return this.ads.getAds(q);
  }

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'إنشاء حملة إعلانية' })
  create(@Body() dto: CreateCampaignDto, @Request() req: any) {
    return this.ads.createCampaign(req.user.companyId, dto);
  }

  @Get('my/campaigns')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'حملاتي الإعلانية + إحصائيات' })
  myCampaigns(@Request() req: any) {
    return this.ads.getCampaignStats(req.user.companyId);
  }

  // ── Admin approval queue (owner dashboard) ─────────────────────
  @Get('admin/pending')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الحملات الإعلانية المعلّقة للمراجعة (أدمن)' })
  getPending(@Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.ads.getPendingCampaigns();
  }

  @Post(':id/review')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الموافقة على حملة إعلانية أو رفضها (أدمن)' })
  review(@Param('id') id: string, @Body() body: { approve: boolean }, @Request() req: any) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('هذا الإجراء متاح لفريق الإدارة فقط');
    }
    return this.ads.reviewCampaign(id, !!body.approve);
  }

  @Post(':id/impression')
  @ApiOperation({ summary: 'تسجيل مشاهدة إعلان' })
  impression(@Param('id') id: string, @Body() body: { sessionId: string }) {
    return this.ads.recordImpression(id, body.sessionId);
  }

  @Post(':id/click')
  @ApiOperation({ summary: 'تسجيل نقرة + redirect URL' })
  click(@Param('id') id: string, @Request() req: any) {
    return this.ads.recordClick(id, req.user?.sub);
  }

  @Post(':id/conversion')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تسجيل تحويل (RFQ بعد الإعلان)' })
  conversion(@Param('id') id: string) {
    return this.ads.recordConversion(id);
  }

  @Post(':id/pause')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  pause(@Param('id') id: string, @Request() req: any) {
    return this.ads.pauseCampaign(id, req.user.companyId);
  }

  @Post(':id/resume')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  resume(@Param('id') id: string, @Request() req: any) {
    return this.ads.resumeCampaign(id, req.user.companyId);
  }
}
