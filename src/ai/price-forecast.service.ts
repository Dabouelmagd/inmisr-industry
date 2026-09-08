// ─── ai/price-forecast.service.ts ────────────────────────────────
// AI Price Forecasting — توقعات أسعار الخامات الصناعية
// Uses historical order data + external commodity prices

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Controller, Get, Query, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

interface PriceForecast {
  sectorCode:     string;
  commodity:      string;
  currentAvgEgp:  number;
  forecastDays:   number;
  predictions: {
    date:       string;
    priceEgp:   number;
    confidence: number; // 0–1
    trend:      'UP' | 'DOWN' | 'STABLE';
  }[];
  factors: {
    label:  string;
    impact: 'HIGH' | 'MEDIUM' | 'LOW';
    trend:  'UP' | 'DOWN';
  }[];
  recommendation: string;
  generatedAt:    string;
}

@Injectable()
export class PriceForecastService {
  private readonly logger = new Logger(PriceForecastService.name);

  constructor(
    private prisma:  PrismaService,
    private config:  ConfigService,
  ) {}

  // ── MAIN FORECAST ────────────────────────────────────────────
  async getForecast(sectorCode: string, daysAhead = 30): Promise<PriceForecast> {
    const [historicalData, externalPrices] = await Promise.all([
      this.getHistoricalPrices(sectorCode),
      this.getExternalPrices(sectorCode),
    ]);

    const currentAvg = historicalData.avgPrice || 0;
    const trend      = this.calculateTrend(historicalData.prices);
    const volatility = this.calculateVolatility(historicalData.prices);

    // Simple linear regression + seasonality
    const predictions = this.generatePredictions(
      currentAvg, trend, volatility, daysAhead, externalPrices,
    );

    const factors = this.identifyFactors(sectorCode, externalPrices, trend);
    const recommendation = this.buildRecommendation(predictions, factors, sectorCode);

    return {
      sectorCode,
      commodity:      this.getCommodityName(sectorCode),
      currentAvgEgp:  currentAvg,
      forecastDays:   daysAhead,
      predictions,
      factors,
      recommendation,
      generatedAt:    new Date().toISOString(),
    };
  }

  // ── HISTORICAL PRICES from our order data ─────────────────────
  private async getHistoricalPrices(sectorCode: string) {
    const quotes = await this.prisma.rfqQuote.findMany({
      where: {
        status: 'ACCEPTED',
        rfq:    { category: { sectorCode } },
        createdAt: { gte: new Date(Date.now() - 180 * 86400000) }, // 6 months
      },
      include: { rfq: true },
      orderBy: { createdAt: 'asc' },
    });

    if (quotes.length === 0) return { prices: [], avgPrice: 0 };

    const prices = quotes.map(q => ({
      date:  q.createdAt,
      price: q.pricePerUnit,
    }));
    const avgPrice = prices.reduce((s, p) => s + p.price, 0) / prices.length;
    return { prices, avgPrice };
  }

  // ── EXTERNAL COMMODITY PRICES ─────────────────────────────────
  private async getExternalPrices(sectorCode: string): Promise<Record<string, number>> {
    const commodityMap: Record<string, string> = {
      iron_steel:    'STEEL',
      petrochemicals:'NAPHTHA',
      aluminum:      'ALUMINUM',
      food:          'WHEAT',
      solar:         'SILICON',
    };

    const commodity = commodityMap[sectorCode];
    if (!commodity) return {};

    try {
      // Commodity price API (e.g., commodities-api.com)
      const apiKey = this.config.get('COMMODITIES_API_KEY');
      if (!apiKey) return { usdEgpRate: 30.9 }; // Fallback

      const [commodityRes, fxRes] = await Promise.all([
        axios.get(`https://commodities-api.com/api/latest?access_key=${apiKey}&symbols=${commodity}`, { timeout: 5000 }),
        axios.get(`https://api.exchangerate-api.com/v4/latest/USD`, { timeout: 5000 }),
      ]);

      return {
        commodityUsd: commodityRes.data.data?.rates?.[commodity] || 0,
        usdEgpRate:   fxRes.data.rates?.EGP || 30.9,
      };
    } catch (err) {
      this.logger.warn(`External prices unavailable for ${sectorCode}: ${err.message}`);
      return { usdEgpRate: 30.9 };
    }
  }

  // ── TREND CALCULATION ─────────────────────────────────────────
  private calculateTrend(prices: { date: Date; price: number }[]): number {
    if (prices.length < 2) return 0;
    const n = prices.length;
    // Simple linear regression slope
    const xMean = n / 2;
    const yMean = prices.reduce((s, p) => s + p.price, 0) / n;
    let num = 0, den = 0;
    prices.forEach((p, i) => {
      num += (i - xMean) * (p.price - yMean);
      den += (i - xMean) ** 2;
    });
    return den !== 0 ? num / den : 0;
  }

  private calculateVolatility(prices: { price: number }[]): number {
    if (prices.length < 2) return 0.05;
    const avg = prices.reduce((s, p) => s + p.price, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p.price - avg) ** 2, 0) / prices.length;
    return Math.sqrt(variance) / avg; // Coefficient of variation
  }

  // ── GENERATE PREDICTIONS ──────────────────────────────────────
  private generatePredictions(
    basePrice: number, trend: number, volatility: number,
    days: number, external: Record<string, number>,
  ) {
    const predictions = [];
    const usdImpact = external.usdEgpRate ? (external.usdEgpRate - 30.9) / 30.9 * 0.3 : 0;

    for (let d = 1; d <= Math.min(days, 90); d += Math.ceil(days / 10)) {
      const date         = new Date(Date.now() + d * 86400000);
      const trendEffect  = trend * d;
      const noise        = (Math.random() - 0.5) * volatility * basePrice * 0.2;
      const seasonEffect = this.getSeasonalEffect(date, d);
      const price        = Math.max(0, basePrice + trendEffect + noise + usdImpact * basePrice + seasonEffect);

      const confidence = Math.max(0.3, 1 - (d / days) * 0.5 - volatility * 0.3);
      const priceTrend: 'UP' | 'DOWN' | 'STABLE' =
        price > basePrice * 1.02 ? 'UP' :
        price < basePrice * 0.98 ? 'DOWN' : 'STABLE';

      predictions.push({
        date:       date.toISOString().split('T')[0],
        priceEgp:   +price.toFixed(2),
        confidence: +confidence.toFixed(2),
        trend:      priceTrend,
      });
    }
    return predictions;
  }

  private getSeasonalEffect(date: Date, dayIndex: number): number {
    const month = date.getMonth();
    // Egyptian industrial seasonal patterns
    // Ramadan (±varies), Summer heat effect on construction, harvest season
    const seasonal: Record<number, number> = {
      2: 0.02,  // March — pre-Ramadan stockpiling
      3: -0.03, // April — Ramadan slowdown
      6: -0.02, // July — summer slowdown
      9: 0.02,  // October — post-summer recovery
    };
    return (seasonal[month] || 0) * dayIndex * 0.1;
  }

  // ── MARKET FACTORS ────────────────────────────────────────────
  private identifyFactors(
    sectorCode: string,
    external: Record<string, number>,
    trend: number,
  ) {
    const factors = [];

    if (external.usdEgpRate > 31) {
      factors.push({ label: 'ارتفاع سعر الدولار', impact: 'HIGH' as const, trend: 'UP' as const });
    }

    factors.push({
      label:  'الطلب المحلي على المنصة',
      impact: 'MEDIUM' as const,
      trend:  trend > 0 ? 'UP' as const : 'DOWN' as const,
    });

    if (sectorCode === 'iron_steel') {
      factors.push({ label: 'أسعار الحديد العالمية (LME)', impact: 'HIGH' as const, trend: 'UP' as const });
      factors.push({ label: 'تكاليف الطاقة في الإنتاج', impact: 'MEDIUM' as const, trend: 'UP' as const });
    }
    if (sectorCode === 'petrochemicals') {
      factors.push({ label: 'أسعار النفط العالمية', impact: 'HIGH' as const, trend: 'STABLE' as const });
    }
    if (sectorCode === 'food') {
      factors.push({ label: 'الإنتاج الزراعي المحلي', impact: 'MEDIUM' as const, trend: 'DOWN' as const });
      factors.push({ label: 'أسعار القمح العالمية', impact: 'HIGH' as const, trend: 'UP' as const });
    }

    factors.push({ label: 'سياسات الاستيراد والجمارك', impact: 'LOW' as const, trend: 'STABLE' as const });
    return factors;
  }

  private buildRecommendation(predictions: any[], factors: any[], sectorCode: string): string {
    const last = predictions[predictions.length - 1];
    const first = predictions[0];
    if (!last || !first) return 'بيانات غير كافية لإصدار توصية';

    const change = ((last.priceEgp - first.priceEgp) / first.priceEgp) * 100;
    const highImpact = factors.filter(f => f.impact === 'HIGH' && f.trend === 'UP').length;

    if (change > 5 || highImpact >= 2) {
      return `ننصح بالشراء المبكر والتخزين. من المتوقع ارتفاع الأسعار بنحو ${change.toFixed(1)}٪ خلال الفترة القادمة بسبب ${factors.find(f => f.impact === 'HIGH')?.label || 'ضغوط السوق'}.`;
    } else if (change < -5) {
      return `من المتوقع انخفاض الأسعار. ننصح بتأجيل المشتريات الكبيرة لمدة ٢-٣ أسابيع للاستفادة من الأسعار الأفضل.`;
    }
    return `الأسعار مستقرة نسبياً. ننصح بالشراء حسب الاحتياج الفعلي دون تخزين مفرط.`;
  }

  private getCommodityName(sectorCode: string): string {
    const map: Record<string, string> = {
      iron_steel:    'الحديد والصلب', petrochemicals: 'البتروكيماويات',
      aluminum:      'الألومنيوم',    food:           'الصناعات الغذائية',
      textile:       'النسيج والخيوط', solar:          'الطاقة الشمسية',
      chemicals:     'الكيماويات',     pumps_motors:   'مضخات ومواتير',
    };
    return map[sectorCode] || sectorCode;
  }

  // ── BATCH FORECAST for Dashboard ─────────────────────────────
  async getTopSectorForecasts() {
    const topSectors = ['iron_steel', 'petrochemicals', 'aluminum', 'food', 'textile'];
    const results = await Promise.allSettled(
      topSectors.map(s => this.getForecast(s, 30)),
    );
    return results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<PriceForecast>).value);
  }
}

// ─── ai/price-forecast.controller.ts ─────────────────────────────
@ApiTags('ai-forecast')
@Controller('ai/price-forecast')
export class PriceForecastController {
  constructor(private forecast: PriceForecastService) {}

  @Get()
  @ApiOperation({ summary: 'توقع أسعار قطاع صناعي' })
  getForecast(
    @Query('sector') sector: string,
    @Query('days')   days: string,
  ) {
    return this.forecast.getForecast(sector, days ? parseInt(days) : 30);
  }

  @Get('top-sectors')
  @ApiOperation({ summary: 'توقعات أسعار أهم القطاعات' })
  getTopForecasts() {
    return this.forecast.getTopSectorForecasts();
  }
}
