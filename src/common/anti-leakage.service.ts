// ─── common/anti-leakage.service.ts ──────────────────────────────
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface SanitizeResult {
  original: string;
  sanitized: string;
  hasPii: boolean;
  piiTypes: string[];
  wasRedacted: boolean;
  detections: Detection[];
}

interface Detection {
  type: string;
  pattern: string;
  value: string;
  action: 'BLOCK' | 'MASK' | 'WARN';
  replacement: string;
}

@Injectable()
export class AntiLeakageService {
  private readonly logger = new Logger(AntiLeakageService.name);

  // ── Compiled Regex Patterns ────────────────────────────────────
  private readonly PATTERNS = {
    EGYPTIAN_MOBILE: {
      regex: /(?:\+?20|0)?(1[0-9]{9})/g,
      action: 'BLOCK' as const,
      replacement: '[🚫 رقم هاتف محجوب — استخدم المنصة للتواصل]',
      label: 'رقم موبايل مصري',
    },
    LANDLINE: {
      regex: /0[2-9][0-9]{7,8}/g,
      action: 'BLOCK' as const,
      replacement: '[🚫 رقم هاتف محجوب]',
      label: 'رقم ثابت',
    },
    EMAIL: {
      regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
      action: 'MASK' as const,
      replacement: '[📧 بريد محجوب → تواصل@relay.inmisr.net]',
      label: 'بريد إلكتروني',
    },
    WHATSAPP: {
      regex: /(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)[^\s]*/gi,
      action: 'BLOCK' as const,
      replacement: '[🚫 رابط واتساب محجوب]',
      label: 'رابط واتساب',
    },
    TELEGRAM: {
      regex: /(?:t\.me|telegram\.me)[^\s]*/gi,
      action: 'BLOCK' as const,
      replacement: '[🚫 رابط تيليجرام محجوب]',
      label: 'رابط تيليجرام',
    },
    SOCIAL_MEDIA: {
      regex: /(?:facebook\.com|fb\.com|instagram\.com|twitter\.com|linkedin\.com|tiktok\.com)[^\s]*/gi,
      action: 'WARN' as const,
      replacement: '[⚠️ رابط خارجي]',
      label: 'رابط سوشيال ميديا',
    },
    ARABIC_PHONE_TEXT: {
      regex: /(?:رقمي|تليفوني|موبايلي|اتصل|واتساب|تواصل معي|رقم الواتس)[:\s]*[\d\-\s٠١٢٣٤٥٦٧٨٩]{10,}/g,
      action: 'BLOCK' as const,
      replacement: '[🚫 معلومات اتصال محجوبة]',
      label: 'رقم هاتف عربي',
    },
    BANK_ACCOUNT: {
      regex: /\b[0-9]{10,20}\b/g,
      action: 'WARN' as const,
      replacement: '[⚠️ رقم حساب محتمل]',
      label: 'رقم حساب بنكي',
    },
  };

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ── MAIN SANITIZE METHOD ───────────────────────────────────────
  sanitize(content: string): SanitizeResult {
    let sanitized = content;
    const detections: Detection[] = [];
    const piiTypes: string[] = [];
    let hasPii = false;

    for (const [key, pattern] of Object.entries(this.PATTERNS)) {
      const matches = [...content.matchAll(pattern.regex)];
      if (matches.length === 0) continue;

      hasPii = true;
      piiTypes.push(pattern.label);

      for (const match of matches) {
        detections.push({
          type: key,
          pattern: pattern.regex.toString(),
          value: this.maskValue(match[0]),
          action: pattern.action,
          replacement: pattern.replacement,
        });
        sanitized = sanitized.replace(match[0], pattern.replacement);
      }

      // Reset lastIndex for global regexes
      pattern.regex.lastIndex = 0;
    }

    return {
      original: content,
      sanitized,
      hasPii,
      piiTypes,
      wasRedacted: hasPii,
      detections,
    };
  }

  // ── PROCESS MESSAGE (Save + Sanitize + Alert) ─────────────────
  async processMessage(
    content: string,
    senderId: string,
    orderId: string,
    messageId: string,
  ): Promise<SanitizeResult> {
    const result = this.sanitize(content);

    if (result.hasPii) {
      // Log leakage attempt
      await this.prisma.leakageAttempt.create({
        data: {
          userId: senderId,
          messageId,
          orderId,
          patternType: result.piiTypes.join(', '),
          rawContent: content.slice(0, 200),
          sanitized: result.sanitized.slice(0, 200),
          action: 'BLOCKED',
        },
      });

      // Warn user via notification
      await this.notifications.send(
        senderId,
        'SYSTEM',
        'تم حجب معلومات اتصال',
        `تم حذف ${result.piiTypes.join('، ')} من رسالتك. جميع التواصل يجب أن يتم عبر المنصة لضمان حقوقك القانونية.`,
        { messageId, piiTypes: result.piiTypes },
      );

      this.logger.warn(`PII detected in message ${messageId} from user ${senderId}: ${result.piiTypes.join(', ')}`);
    }

    return result;
  }

  // ── PHONE MASKING for UI ───────────────────────────────────────
  maskPhoneNumber(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10) {
      return `+20-${digits.slice(-10, -7)}X-XXXX${digits.slice(-2)}`;
    }
    return '+20-XXX-XXXXXX';
  }

  // ── EMAIL RELAY ────────────────────────────────────────────────
  generateEmailRelay(userId: string): string {
    const hash = Buffer.from(userId).toString('base64').slice(0, 8);
    return `${hash}@relay.inmisr.net`;
  }

  // ── AI ANOMALY DETECTION ───────────────────────────────────────
  async checkUserAnomaly(userId: string, orderId: string): Promise<number> {
    const [recentLeakages, recentViews, recentMessages] = await Promise.all([
      // Leakage attempts in last 24h
      this.prisma.leakageAttempt.count({
        where: { userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
      // Activity stopped after messaging?
      this.prisma.message.count({
        where: { senderId: userId, order: { id: orderId }, createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
      }),
      // Repeated view of same supplier without ordering
      this.prisma.auditLog.count({
        where: {
          userId,
          action: 'VIEW_SUPPLIER',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    // Score 0-100 (higher = more suspicious)
    let score = 0;
    if (recentLeakages >= 3) score += 50;
    else if (recentLeakages >= 1) score += 20;
    if (recentViews >= 10) score += 30;
    else if (recentViews >= 5) score += 15;

    if (score >= 40) {
      await this.prisma.anomalyAlert.create({
        data: {
          userId,
          type: 'LEAKAGE_RISK',
          score,
          description: `محاولات تسريب: ${recentLeakages} — مشاهدات متكررة: ${recentViews}`,
          metadata: { recentLeakages, recentViews, recentMessages },
        },
      });

      this.logger.warn(`High leakage risk for user ${userId}: score=${score}`);
    }

    return score;
  }

  // ── WATERMARK DOCUMENTS ───────────────────────────────────────
  generateWatermarkPayload(orderId: string, userId: string): string {
    const payload = {
      order_id: orderId,
      user_id: userId.slice(-8),
      platform: 'inmisr.net',
      timestamp: Date.now(),
      signature: Buffer.from(`${orderId}:${userId}:${Date.now()}`).toString('base64').slice(0, 16),
    };
    // In production: inject into PDF binary via steganography library
    return JSON.stringify(payload);
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private maskValue(value: string): string {
    if (value.length <= 4) return '****';
    return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
  }

  // ── STATISTICS ────────────────────────────────────────────────
  async getStats() {
    const [total, thisMonth, anomalies] = await Promise.all([
      this.prisma.leakageAttempt.count(),
      this.prisma.leakageAttempt.count({
        where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
      this.prisma.anomalyAlert.count({ where: { isResolved: false } }),
    ]);

    return { totalBlocked: total, thisMonthBlocked: thisMonth, openAnomalies: anomalies };
  }
}
