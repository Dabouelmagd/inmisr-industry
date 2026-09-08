// ─── ads/ads.service.ts ───────────────────────────────────────────
// نظام الإعلانات الممولة — Sponsored listings + CPC/CPM tracking
// موردو GROWTH/ELITE يمكنهم ترقية ظهورهم في نتائج البحث

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
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

  // In production: store in PostgreSQL with Prisma
  // Using in-memory map for structure demonstration
  private campaigns = new Map<string, AdCampaign>();

  constructor(private prisma: PrismaService) {}

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

    const id = `ad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const campaign: AdCampaign = {
      id, companyId,
      name:         dto.name,
      type:         dto.type,
      bidModel:     dto.bidModel,
      bidAmount:    dto.bidAmount,
      dailyBudget:  dto.dailyBudget,
      totalBudget:  dto.totalBudget,
      startDate:    new Date(dto.startDate),
      endDate:      new Date(dto.endDate),
      status:       'PENDING',
      targetSectors: dto.targetSectors,
      targetCities:  dto.targetCities,
      creativeJson:  dto.creative,
      stats:        { impressions: 0, clicks: 0, spent: 0, ctr: 0, conversions: 0 },
    };

    this.campaigns.set(id, campaign);
    this.logger.log(`Campaign created: ${id} by company ${companyId}`);
    return campaign;
  }

  // ── GET SPONSORED ADS for a context ──────────────────────────
  async getAds(context: {
    type:    AdType;
    sector?: string;
    city?:   string;
    limit?:  number;
  }): Promise<AdCampaign[]> {
    const now = new Date();
    const active = [...this.campaigns.values()].filter(c => {
      if (c.status !== 'ACTIVE') return false;
      if (c.type !== context.type) return false;
      if (c.startDate > now || c.endDate < now) return false;
      if (c.stats.spent >= c.totalBudget) return false;
      if (context.sector && c.targetSectors?.length &&
          !c.targetSectors.includes(context.sector)) return false;
      if (context.city && c.targetCities?.length &&
          !c.targetCities.includes(context.city)) return false;
      return true;
    });

    // Sort by bid amount (highest bid = highest position)
    return active
      .sort((a, b) => b.bidAmount - a.bidAmount)
      .slice(0, context.limit || 3);
  }

  // ── RECORD IMPRESSION ────────────────────────────────────────
  async recordImpression(campaignId: string, sessionId: string) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;

    campaign.stats.impressions++;
    if (campaign.bidModel === 'CPM') {
      const cost = campaign.bidAmount / 1000;
      campaign.stats.spent += cost;
      await this.checkDailyBudget(campaign);
    }
    campaign.stats.ctr = campaign.stats.impressions > 0
      ? (campaign.stats.clicks / campaign.stats.impressions) * 100
      : 0;
  }

  // ── RECORD CLICK ─────────────────────────────────────────────
  async recordClick(campaignId: string, userId?: string): Promise<{ allowed: boolean; url: string }> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'ACTIVE') return { allowed: false, url: '' };

    campaign.stats.clicks++;
    if (campaign.bidModel === 'CPC') {
      campaign.stats.spent += campaign.bidAmount;
      await this.checkDailyBudget(campaign);
    }
    campaign.stats.ctr = campaign.stats.impressions > 0
      ? (campaign.stats.clicks / campaign.stats.impressions) * 100
      : 0;

    this.logger.log(`Ad click: ${campaignId}, total clicks: ${campaign.stats.clicks}, spent: ${campaign.stats.spent}`);
    return { allowed: true, url: campaign.creativeJson.destinationUrl };
  }

  // ── RECORD CONVERSION (RFQ created) ──────────────────────────
  async recordConversion(campaignId: string) {
    const campaign = this.campaigns.get(campaignId);
    if (campaign) campaign.stats.conversions++;
  }

  // ── CAMPAIGN ANALYTICS ────────────────────────────────────────
  async getCampaignStats(companyId: string) {
    const companyCampaigns = [...this.campaigns.values()]
      .filter(c => c.companyId === companyId);

    const total = companyCampaigns.reduce((acc, c) => ({
      impressions: acc.impressions + c.stats.impressions,
      clicks:      acc.clicks      + c.stats.clicks,
      spent:       acc.spent       + c.stats.spent,
      conversions: acc.conversions + c.stats.conversions,
    }), { impressions: 0, clicks: 0, spent: 0, conversions: 0 });

    return {
      campaigns: companyCampaigns,
      totals: {
        ...total,
        avgCtr: total.impressions > 0 ? (total.clicks / total.impressions) * 100 : 0,
        costPerConversion: total.conversions > 0 ? total.spent / total.conversions : 0,
        roi: total.spent > 0 ? (total.conversions * 500) / total.spent : 0, // Estimated ROI
      },
    };
  }

  async pauseCampaign(id: string, companyId: string) {
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new NotFoundException();
    if (campaign.companyId !== companyId) throw new BadRequestException('Forbidden');
    campaign.status = 'PAUSED';
    return campaign;
  }

  async resumeCampaign(id: string, companyId: string) {
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new NotFoundException();
    if (campaign.companyId !== companyId) throw new BadRequestException('Forbidden');
    campaign.status = 'ACTIVE';
    return campaign;
  }

  private async checkDailyBudget(campaign: AdCampaign) {
    // Simple daily budget check — in production: track per-day spend
    if (campaign.stats.spent >= campaign.totalBudget) {
      campaign.status = 'COMPLETED';
      this.logger.log(`Campaign ${campaign.id} budget exhausted — paused`);
    }
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
