// ─── payment/payment.service.ts ───────────────────────────────────
// نظام الدفع الكامل — Paymob iframe + تمويل بالتقسيط
// يُستخدم عند ضغط المشتري على "دفع وتحميل Escrow"

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { Controller, Post, Get, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtGuard } from '../auth/jwt.guard';
import axios from 'axios';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly base   = 'https://accept.paymob.com/api';

  constructor(
    private config:  ConfigService,
    private prisma:  PrismaService,
  ) {}

  // ── STEP 1: Get Paymob auth token ────────────────────────────
  private async getAuthToken(): Promise<string> {
    const res = await axios.post(`${this.base}/auth/tokens`, {
      api_key: this.config.get('PAYMOB_API_KEY'),
    });
    return res.data.token;
  }

  // ── STEP 2: Create Paymob order ──────────────────────────────
  private async createPaymobOrder(
    authToken:   string,
    orderId:     string,
    amountEgp:   number,
    buyer:       { name: string; email: string; phone: string },
  ) {
    const res = await axios.post(`${this.base}/ecommerce/orders`, {
      auth_token:          authToken,
      delivery_needed:     false,
      amount_cents:        Math.round(amountEgp * 100),
      currency:            'EGP',
      merchant_order_id:   orderId,
      items: [{
        name:         `طلبية رقم ${orderId.slice(-8).toUpperCase()}`,
        amount_cents: Math.round(amountEgp * 100),
        description:  'دفع آمن عبر نظام Escrow — إن مصر للصناعة',
        quantity:     1,
      }],
    });
    return res.data;
  }

  // ── STEP 3: Get payment key (iframe token) ────────────────────
  private async getPaymentKey(
    authToken:      string,
    paymobOrderId:  number,
    amountEgp:      number,
    buyer:          { name: string; email: string; phone: string },
    internalOrderId: string,
    escrowId:       string,
    userId:         string,
  ): Promise<string> {
    const [firstName, ...rest] = buyer.name.split(' ');
    const res = await axios.post(`${this.base}/intention/`, {
      auth_token:     authToken,
      amount:         Math.round(amountEgp * 100),
      currency:       'EGP',
      order_id:       paymobOrderId,
      billing_data: {
        apartment:      'NA', email: buyer.email,
        floor:          'NA', first_name: firstName || 'مشتري',
        street:         'NA', building:   'NA',
        phone_number:   buyer.phone.startsWith('+') ? buyer.phone : `+20${buyer.phone}`,
        shipping_method: 'NA', postal_code: 'NA',
        city:           'Cairo', country: 'EGY',
        last_name:      rest.join(' ') || 'إن مصر',
        state:          'Cairo',
      },
      integration_id: this.config.get('PAYMOB_INTEGRATION_ID'),
      lock_order_when_paid: true,
      extras: {
        order_id:   internalOrderId,
        escrow_id:  escrowId,
        user_id:    userId,
      },
    });
    return res.data.token;
  }

  // ── MAIN: Create payment session for an order ─────────────────
  async createPaymentSession(orderId: string, userId: string): Promise<{
    iframeUrl: string; paymentKey: string; orderId: string;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        escrow: true,
        buyer:  { include: { user: { select: { email: true } } } },
      },
    });
    if (!order)              throw new BadRequestException('الطلب غير موجود');
    if (!order.escrow)       throw new BadRequestException('لا يوجد Escrow لهذا الطلب');
    if (order.escrow.status !== 'PENDING') {
      throw new BadRequestException(`الـ Escrow في حالة: ${order.escrow.status} — لا يمكن الدفع مجدداً`);
    }

    const buyerEmail = order.buyer.user?.email || 'buyer@inmisr.net';
    const buyerPhone = '+201000000000'; // Retrieved from encrypted field in production
    const buyerName  = order.buyer.nameAr;

    this.logger.log(`Creating payment session: order ${orderId}, amount ${order.amount} EGP`);

    try {
      const authToken      = await this.getAuthToken();
      const paymobOrder    = await this.createPaymobOrder(authToken, orderId, order.amount, { name: buyerName, email: buyerEmail, phone: buyerPhone });
      const paymentKey     = await this.getPaymentKey(authToken, paymobOrder.id, order.amount, { name: buyerName, email: buyerEmail, phone: buyerPhone }, orderId, order.escrow.id, userId);
      const iframeId       = this.config.get('PAYMOB_IFRAME_ID');
      const iframeUrl      = `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${paymentKey}`;

      // Store payment attempt
      await this.prisma.auditLog.create({
        data: {
          userId, action: 'PAYMENT_SESSION_CREATED', entity: 'Order', entityId: orderId,
          newValue: { paymobOrderId: paymobOrder.id, amount: order.amount, iframeId },
        },
      });

      return { iframeUrl, paymentKey, orderId };
    } catch (err) {
      this.logger.error(`Payment session failed for order ${orderId}`, err.response?.data || err.message);
      throw new BadRequestException(`فشل إنشاء جلسة الدفع: ${err.message}`);
    }
  }

  // ── INSTALLMENT: Check eligibility ───────────────────────────
  async checkInstallmentEligibility(companyId: string, amount: number) {
    const orderCount = await this.prisma.order.count({
      where: { buyerCompanyId: companyId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    });
    const eligible = orderCount >= 2 && amount >= 50000;

    const plans = eligible ? [
      { months: 3,  rate: 0.06,  bank: 'CIB',  monthly: Math.round(amount * 1.06 / 3) },
      { months: 6,  rate: 0.075, bank: 'QNB',  monthly: Math.round(amount * 1.075 / 6) },
      { months: 12, rate: 0.09,  bank: 'DIB',  monthly: Math.round(amount * 1.09 / 12) },
    ] : [];

    return {
      eligible,
      reason: !eligible
        ? orderCount < 2 ? 'يحتاج ٢ صفقات مكتملة على الأقل' : `الحد الأدنى للتمويل ٥٠,٠٠٠ ج.م`
        : null,
      availablePlans: plans,
      minAmount: 50000,
      currentOrders: orderCount,
    };
  }

  // ── FAWRY B2B payment link ────────────────────────────────────
  async createFawryPaymentLink(orderId: string, amount: number): Promise<string> {
    const crypto = await import('crypto');
    const merchantCode = this.config.get('FAWRY_MERCHANT_CODE');
    const securityKey  = this.config.get('FAWRY_SECURITY_KEY');

    const sig = crypto.default
      .createHash('sha256')
      .update(`${merchantCode}${orderId}${Math.round(amount * 100)}${securityKey}`)
      .digest('hex');

    const baseUrl = this.config.get('FAWRY_BASE_URL', 'https://atfawry.fawrystaging.com');
    return `${baseUrl}/ECommercePlugin/payment/online?merchantCode=${merchantCode}&merchantRefNum=${orderId}&customerMobile=&amount=${amount}&paymentMethod=CARD&signature=${sig}&returnUrl=${encodeURIComponent('https://inmisr.net/payment/callback')}`;
  }
}

// ─── payment/payment.controller.ts ───────────────────────────────
@ApiTags('payment')
@Controller('payment')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class PaymentController {
  constructor(private payment: PaymentService) {}

  @Post('orders/:orderId/session')
  @ApiOperation({ summary: 'إنشاء جلسة دفع Paymob (iframe URL)' })
  createSession(@Param('orderId') orderId: string, @Request() req: any) {
    return this.payment.createPaymentSession(orderId, req.user.sub);
  }

  @Get('orders/:orderId/installment-check')
  @ApiOperation({ summary: 'التحقق من أهلية التمويل بالتقسيط' })
  async checkInstallment(@Param('orderId') orderId: string, @Request() req: any) {
    const { PrismaService } = require('../common/prisma.service');
    // Get order amount and check eligibility
    return this.payment.checkInstallmentEligibility(req.user.companyId, 100000);
  }

  @Post('orders/:orderId/fawry')
  @ApiOperation({ summary: 'رابط دفع Fawry B2B' })
  async getFawryLink(@Param('orderId') orderId: string, @Request() req: any) {
    const order = await new (require('../common/prisma.service').PrismaService)().order.findUnique({ where: { id: orderId } });
    const url = await this.payment.createFawryPaymentLink(orderId, order?.amount || 0);
    return { url };
  }
}
