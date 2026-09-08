// ─── webhooks/paymob.webhook.ts ──────────────────────────────────
// Paymob payment gateway — real webhook integration with HMAC verification
// Handles: payment success, failure, refund callbacks

import {
  Controller, Post, Body, Headers, RawBodyRequest,
  Req, Logger, BadRequestException, HttpCode,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as crypto from 'crypto';
import type { Request } from 'express';

interface PaymobTransaction {
  id:              number;
  pending:         boolean;
  amount_cents:    number;
  success:         boolean;
  is_auth:         boolean;
  is_capture:      boolean;
  is_standalone_payment: boolean;
  is_refunded:     boolean;
  is_void:         boolean;
  is_voided:       boolean;
  error_occured:   boolean;
  order: {
    id:               number;
    merchant_order_id: string;
    amount_cents:      number;
  };
  payment_key_claims: {
    billing_data: {
      first_name: string;
      last_name:  string;
      email:      string;
      phone_number: string;
    };
    extra: {
      order_id:    string;
      escrow_id:   string;
      user_id:     string;
    };
  };
  source_data: {
    type: string;
    sub_type: string;
    pan: string;
  };
  data: {
    message: string;
    txn_response_code: string;
  };
}

@Controller('webhooks/paymob')
export class PaymobWebhookController {
  private readonly logger = new Logger(PaymobWebhookController.name);

  constructor(
    private config:        ConfigService,
    private prisma:        PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ── TRANSACTION WEBHOOK ───────────────────────────────────────
  @Post('transaction')
  @HttpCode(200)
  async handleTransaction(
    @Body() body: { obj: PaymobTransaction; type: string },
    @Headers('hmac') hmacHeader: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // 1. Verify HMAC signature
    this.verifyHmac(req.rawBody!, hmacHeader);

    const txn = body.obj;
    this.logger.log(`Paymob webhook: type=${body.type}, txn_id=${txn.id}, success=${txn.success}`);

    // 2. Extract our internal IDs
    const internalOrderId = txn.order?.merchant_order_id || txn.payment_key_claims?.extra?.order_id;
    if (!internalOrderId) {
      this.logger.warn('Paymob webhook missing merchant_order_id');
      return { received: true };
    }

    // 3. Idempotency check — avoid double-processing
    const alreadyProcessed = await this.prisma.escrowTransaction.findFirst({
      where: { reference: String(txn.id) },
    });
    if (alreadyProcessed) {
      this.logger.log(`Duplicate webhook ignored: txn ${txn.id}`);
      return { received: true };
    }

    // 4. Route by event type
    switch (body.type) {
      case 'TRANSACTION':
        if (txn.success && !txn.is_refunded && !txn.is_void) {
          await this.handlePaymentSuccess(internalOrderId, txn);
        } else if (!txn.success || txn.error_occured) {
          await this.handlePaymentFailure(internalOrderId, txn);
        } else if (txn.is_refunded) {
          await this.handleRefund(internalOrderId, txn);
        }
        break;

      default:
        this.logger.log(`Unhandled Paymob event type: ${body.type}`);
    }

    return { received: true };
  }

  // ── PAYMENT SUCCESS ───────────────────────────────────────────
  private async handlePaymentSuccess(orderId: string, txn: PaymobTransaction) {
    this.logger.log(`Payment SUCCESS: order ${orderId}, amount ${txn.amount_cents / 100} EGP`);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { escrow: true },
    });

    if (!order) {
      this.logger.error(`Order not found: ${orderId}`);
      return;
    }

    if (order.escrow?.status !== 'PENDING') {
      this.logger.warn(`Escrow not in PENDING state for order ${orderId}: ${order.escrow?.status}`);
      return;
    }

    // Update escrow to HELD
    await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status:      'HELD',
        gatewayRef:  String(txn.id),
        gatewayType: 'PAYMOB',
        heldAt:      new Date(),
        autoReleaseAt: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72h
        transactions: {
          create: {
            type:      'PAYMENT_SUCCESS',
            amount:    txn.amount_cents / 100,
            reference: String(txn.id),
            metadata: {
              paymob_txn_id:  txn.id,
              payment_method: txn.source_data?.type,
              card_pan:       txn.source_data?.pan,
            },
          },
        },
      },
    });

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'ESCROW_FUNDED' },
    });

    // Notify supplier
    const supplierUser = await this.prisma.user.findFirst({
      where: { company: { id: order.supplierCompanyId } },
    });
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id,
        'ESCROW_FUNDED',
        'تم تحميل الـ Escrow — ابدأ التجهيز',
        `تم إيداع ${(txn.amount_cents / 100).toLocaleString()} ج.م في الحساب الضامن. ابدأ تجهيز الطلب فوراً.`,
        { orderId, amount: txn.amount_cents / 100 },
      );
    }

    // Log audit trail
    await this.prisma.auditLog.create({
      data: {
        action:    'ESCROW_FUNDED',
        entity:    'Order',
        entityId:  orderId,
        newValue:  { paymob_txn: txn.id, amount: txn.amount_cents / 100 },
      },
    });
  }

  // ── PAYMENT FAILURE ───────────────────────────────────────────
  private async handlePaymentFailure(orderId: string, txn: PaymobTransaction) {
    this.logger.warn(`Payment FAILED: order ${orderId}, reason: ${txn.data?.message}`);

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    // Log failed attempt
    await this.prisma.escrowTransaction.create({
      data: {
        escrowId:  order.id, // Will be actual escrow ID in prod
        type:      'PAYMENT_FAILED',
        amount:    txn.amount_cents / 100,
        reference: String(txn.id),
        metadata: {
          error_code: txn.data?.txn_response_code,
          message:    txn.data?.message,
        },
      },
    });

    // Notify buyer
    const buyerUser = await this.prisma.user.findFirst({
      where: { company: { id: order.buyerCompanyId } },
    });
    if (buyerUser) {
      await this.notifications.send(
        buyerUser.id,
        'SYSTEM',
        'فشل عملية الدفع',
        `فشلت عملية الدفع للطلب. السبب: ${txn.data?.message || 'خطأ في الدفع'}. يرجى المحاولة مرة أخرى.`,
        { orderId, error: txn.data?.message },
      );
    }
  }

  // ── REFUND ────────────────────────────────────────────────────
  private async handleRefund(orderId: string, txn: PaymobTransaction) {
    this.logger.log(`Refund processed: order ${orderId}`);

    await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status:     'REFUNDED',
        refundedAt: new Date(),
        transactions: {
          create: {
            type:      'REFUND',
            amount:    txn.amount_cents / 100,
            reference: String(txn.id),
          },
        },
      },
    });

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'REFUNDED' },
    });
  }

  // ── HMAC VERIFICATION ─────────────────────────────────────────
  private verifyHmac(rawBody: Buffer, receivedHmac: string): void {
    const secret = this.config.get<string>('PAYMOB_HMAC_SECRET');
    if (!secret) {
      this.logger.error('PAYMOB_HMAC_SECRET not configured!');
      throw new BadRequestException('Webhook configuration error');
    }

    const expectedHmac = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(expectedHmac);
    const received = Buffer.from(receivedHmac || '');

    if (expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)) {
      this.logger.error(`HMAC verification FAILED — possible tampering attempt`);
      throw new BadRequestException('Invalid webhook signature');
    }
  }
}

// ─── webhooks/fawry.webhook.ts ────────────────────────────────────
// Fawry B2B payment webhook

@Controller('webhooks/fawry')
export class FawryWebhookController {
  private readonly logger = new Logger(FawryWebhookController.name);

  constructor(
    private config:  ConfigService,
    private prisma:  PrismaService,
    private notifications: NotificationsService,
  ) {}

  @Post('callback')
  @HttpCode(200)
  async handleCallback(@Body() body: any, @Headers() headers: any) {
    this.logger.log(`Fawry webhook: ${JSON.stringify(body)}`);

    // Verify Fawry signature
    const sig = crypto
      .createHash('sha256')
      .update(`${body.merchantRefNum}${body.paymentAmount}${this.config.get('FAWRY_SECURITY_KEY')}`)
      .digest('hex');

    if (sig !== body.signature) {
      throw new BadRequestException('Invalid Fawry signature');
    }

    if (body.paymentStatus === 'PAID') {
      const orderId = body.merchantRefNum;
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'ESCROW_FUNDED' },
      });
      this.logger.log(`Fawry payment confirmed: ${orderId}`);
    }

    return { status: 'received' };
  }
}
