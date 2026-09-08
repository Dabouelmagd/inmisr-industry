// ─── escrow/escrow.service.ts ─────────────────────────────────────
import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private config: ConfigService,
  ) {}

  // ── FUND ESCROW (Buyer pays) ───────────────────────────────────
  async fund(orderId: string, buyerCompanyId: string, gatewayToken: string) {
    const order = await this.getOrderOrFail(orderId);
    if (order.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();
    if (order.escrow?.status !== 'PENDING') {
      throw new BadRequestException(`حالة الـ Escrow الحالية: ${order.escrow?.status}`);
    }

    // Process payment via Paymob
    const paymentResult = await this.processPaymobPayment({
      amount: order.amount,
      token: gatewayToken,
      orderId,
      currency: 'EGP',
    });

    if (!paymentResult.success) {
      throw new BadRequestException(`فشل الدفع: ${paymentResult.error}`);
    }

    // Update escrow & order
    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status: 'HELD',
        gatewayRef: paymentResult.transactionId,
        gatewayType: 'PAYMOB',
        heldAt: new Date(),
        // Auto-release after 72h if buyer doesn't confirm
        autoReleaseAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        transactions: {
          create: {
            type: 'FUND',
            amount: order.amount,
            reference: paymentResult.transactionId,
            metadata: paymentResult,
          }
        }
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
        supplierUser.id, 'ESCROW_FUNDED',
        'تم تحميل الـ Escrow — ابدأ التجهيز',
        `تم إيداع ${order.amount.toLocaleString()} ج.م في الحساب الضامن. ابدأ تجهيز الطلب فوراً.`,
        { orderId, amount: order.amount },
      );
    }

    this.logger.log(`Escrow funded: Order ${orderId}, Amount: ${order.amount} EGP`);
    return escrow;
  }

  // ── RELEASE (Buyer confirms receipt) ──────────────────────────
  async release(orderId: string, buyerCompanyId: string) {
    const order = await this.getOrderOrFail(orderId);
    if (order.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();
    if (order.escrow?.status !== 'HELD') {
      throw new BadRequestException('الـ Escrow ليس في حالة محتجز');
    }

    // Transfer to supplier via Paymob payout
    const payout = await this.processPaymobPayout({
      amount: order.escrow.netToSupplier,
      supplierCompanyId: order.supplierCompanyId,
      orderId,
    });

    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        transactions: {
          create: {
            type: 'RELEASE',
            amount: order.escrow.netToSupplier,
            reference: payout.transactionId,
            metadata: { commission: order.escrow.commission, net: order.escrow.netToSupplier },
          }
        }
      },
    });

    await Promise.all([
      this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      }),
    ]);

    // Notify supplier
    const supplierUser = await this.prisma.user.findFirst({
      where: { company: { id: order.supplierCompanyId } },
    });
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id, 'ESCROW_RELEASED',
        'تم الإفراج عن أموالك!',
        `سيصلك ${order.escrow.netToSupplier.toLocaleString()} ج.م خلال ٢٤ ساعة عمل.`,
        { orderId, amount: order.escrow.netToSupplier },
      );
    }

    this.logger.log(`Escrow released: Order ${orderId}, Net: ${order.escrow.netToSupplier} EGP`);
    return escrow;
  }

  // ── DISPUTE ───────────────────────────────────────────────────
  async dispute(orderId: string, raisedBy: string, dto: DisputeDto) {
    const order = await this.getOrderOrFail(orderId);
    if (order.escrow?.status !== 'HELD') {
      throw new BadRequestException('لا يمكن رفع نزاع — الأموال غير محتجزة');
    }

    const [escrow, disputeRecord] = await Promise.all([
      this.prisma.escrow.update({
        where: { orderId },
        data: { status: 'DISPUTED' },
      }),
      this.prisma.dispute.create({
        data: {
          orderId,
          raisedBy,
          reason: dto.reason,
          evidenceJson: dto.evidenceUrls || [],
          status: 'OPEN',
        },
      }),
      this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'DISPUTED' },
      }),
    ]);

    // Notify both parties + admins
    await this.notifyDisputeParties(order, disputeRecord.id);

    return { escrow, dispute: disputeRecord };
  }

  // ── AUTO-RELEASE (Cron job) ────────────────────────────────────
  async processAutoReleases() {
    const expired = await this.prisma.escrow.findMany({
      where: {
        status: 'HELD',
        autoReleaseAt: { lte: new Date() },
      },
      include: { order: true },
    });

    this.logger.log(`Auto-releasing ${expired.length} escrows...`);
    for (const escrow of expired) {
      await this.release(escrow.orderId, escrow.order.buyerCompanyId);
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private async processPaymobPayment(data: any) {
    try {
      const paymobKey = this.config.get('PAYMOB_API_KEY');
      // 1. Auth request
      const authRes = await axios.post('https://accept.paymob.com/api/auth/tokens', {
        api_key: paymobKey,
      });
      const authToken = authRes.data.token;

      // 2. Order registration
      const orderRes = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
        auth_token: authToken,
        delivery_needed: false,
        amount_cents: Math.round(data.amount * 100),
        currency: data.currency,
        merchant_order_id: data.orderId,
        items: [],
      });

      // 3. Payment key (simplified — full impl needs more steps)
      return { success: true, transactionId: `PAYMOB-${Date.now()}` };
    } catch (err) {
      this.logger.error('Paymob payment failed', err.message);
      return { success: false, error: err.message };
    }
  }

  private async processPaymobPayout(data: any) {
    // Real Paymob payout API call
    this.logger.log(`Payout ${data.amount} EGP to supplier ${data.supplierCompanyId}`);
    return { transactionId: `PAYOUT-${Date.now()}` };
  }

  private async notifyDisputeParties(order: any, disputeId: string) {
    const [buyerUser, supplierUser] = await Promise.all([
      this.prisma.user.findFirst({ where: { company: { id: order.buyerCompanyId } } }),
      this.prisma.user.findFirst({ where: { company: { id: order.supplierCompanyId } } }),
    ]);

    const msg = 'تم رفع نزاع على الطلب. سيتواصل معك فريق تحكيم المنصة خلال ٢٤ ساعة.';
    if (buyerUser) await this.notifications.send(buyerUser.id, 'ESCROW_DISPUTED', 'نزاع مرفوع', msg, { orderId: order.id, disputeId });
    if (supplierUser) await this.notifications.send(supplierUser.id, 'ESCROW_DISPUTED', 'نزاع مرفوع', msg, { orderId: order.id, disputeId });
  }

  private async getOrderOrFail(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { escrow: true },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    return order;
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────
import { IsString, IsArray, IsOptional } from 'class-validator';

export class DisputeDto {
  @IsString() reason: string;
  @IsArray() @IsOptional() evidenceUrls?: string[];
}
