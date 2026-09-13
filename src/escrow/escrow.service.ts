// ─── escrow/escrow.service.ts ─────────────────────────────────────
// MANUAL PAYMENT FLOW: no payment gateway is connected yet (decided
// 2026-09-13 — Paymob integration is not ready and money movement is
// handled manually by the admin team via bank transfer until it is).
// Every step here is honest about that: the buyer declares a transfer
// they made outside the platform, an admin manually verifies it in
// the real bank account before marking funds held, and the same
// applies in reverse for paying the supplier. Nothing here claims to
// move money automatically.
import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ── STEP 1: BUYER DECLARES A BANK TRANSFER THEY MADE ───────────
  async declarePayment(orderId: string, buyerCompanyId: string, dto: { reference: string; note?: string }) {
    const order = await this.getOrderOrFail(orderId);
    if (order.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();
    if (order.escrow?.status !== 'PENDING') {
      throw new BadRequestException(`حالة الـ Escrow الحالية: ${order.escrow?.status}`);
    }
    if (!dto.reference?.trim()) throw new BadRequestException('رقم/مرجع التحويل البنكي مطلوب');

    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        fundProofRef: dto.reference,
        fundDeclaredAt: new Date(),
        transactions: {
          create: {
            type: 'FUND_DECLARED',
            amount: order.amount,
            reference: dto.reference,
            metadata: { note: dto.note },
          },
        },
      },
    });

    await this.notifyAdmins(
      'ESCROW_FUNDED',
      'طلب تأكيد استلام تحويل بنكي',
      `المشتري أعلن تحويل ${order.amount.toLocaleString()} ج.م للطلب #${orderId.slice(-8)} — مرجع: ${dto.reference}. يرجى التأكد من وصول المبلغ للحساب البنكي وتأكيده يدويًا.`,
      { orderId, amount: order.amount },
    );

    this.logger.log(`Payment declared: Order ${orderId}, ref ${dto.reference} — awaiting manual admin confirmation`);
    return escrow;
  }

  // ── STEP 2: ADMIN MANUALLY CONFIRMS THE MONEY ACTUALLY ARRIVED ──
  async adminConfirmFunded(orderId: string, dto?: { note?: string }) {
    const order = await this.getOrderOrFail(orderId);
    if (order.escrow?.status !== 'PENDING') {
      throw new BadRequestException(`حالة الـ Escrow الحالية: ${order.escrow?.status}`);
    }
    if (!order.escrow?.fundDeclaredAt) {
      throw new BadRequestException('لم يُعلن المشتري عن تحويل بعد لهذا الطلب');
    }

    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status: 'HELD',
        heldAt: new Date(),
        transactions: {
          create: {
            type: 'FUND_CONFIRMED',
            amount: order.amount,
            reference: order.escrow.fundProofRef,
            metadata: { note: dto?.note, confirmedManuallyByAdmin: true },
          },
        },
      },
    });

    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'ESCROW_FUNDED' } });

    const supplierUser = await this.prisma.user.findFirst({ where: { company: { id: order.supplierCompanyId } } });
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id, 'ESCROW_FUNDED',
        'تم تأكيد استلام الدفعة — ابدأ التجهيز',
        `تم تأكيد إيداع ${order.amount.toLocaleString()} ج.م في الحساب الضامن. ابدأ تجهيز الطلب فوراً.`,
        { orderId, amount: order.amount },
      );
    }

    this.logger.log(`Escrow manually confirmed funded: Order ${orderId}, Amount: ${order.amount} EGP`);
    return escrow;
  }

  // ── STEP 3: BUYER CONFIRMS THEY RECEIVED THE GOODS ─────────────
  // This does NOT release money by itself — it flags the order as
  // ready for payout so an admin can manually transfer the net
  // amount to the supplier's bank account and confirm it below.
  async buyerConfirmReceipt(orderId: string, buyerCompanyId: string) {
    const order = await this.getOrderOrFail(orderId);
    if (order.buyerCompanyId !== buyerCompanyId) throw new ForbiddenException();
    if (order.escrow?.status !== 'HELD') {
      throw new BadRequestException('الـ Escrow ليس في حالة محتجز');
    }

    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        buyerConfirmedAt: new Date(),
        transactions: {
          create: { type: 'BUYER_CONFIRMED_RECEIPT', amount: order.amount },
        },
      },
    });

    await this.notifyAdmins(
      'ORDER_DELIVERED',
      'المشتري أكد الاستلام — الطلب جاهز لتحويل المستحقات للمورد',
      `أكد المشتري استلام الطلب #${orderId.slice(-8)}. المطلوب تحويل ${order.escrow.netToSupplier.toLocaleString()} ج.م للمورد بنكيًا ثم تأكيد التحويل يدويًا.`,
      { orderId, amount: order.escrow.netToSupplier },
    );

    this.logger.log(`Buyer confirmed receipt: Order ${orderId} — awaiting manual admin payout`);
    return escrow;
  }

  // ── STEP 4: ADMIN MANUALLY TRANSFERS TO SUPPLIER, THEN CONFIRMS ──
  async adminConfirmPayout(orderId: string, dto: { transferRef: string; note?: string }) {
    const order = await this.getOrderOrFail(orderId);
    if (order.escrow?.status !== 'HELD') {
      throw new BadRequestException('الـ Escrow ليس في حالة محتجز');
    }
    if (!order.escrow?.buyerConfirmedAt) {
      throw new BadRequestException('المشتري لم يؤكد استلام الطلب بعد');
    }
    if (!dto.transferRef?.trim()) throw new BadRequestException('رقم/مرجع التحويل البنكي للمورد مطلوب');

    const escrow = await this.prisma.escrow.update({
      where: { orderId },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        payoutProofRef: dto.transferRef,
        transactions: {
          create: {
            type: 'RELEASE',
            amount: order.escrow.netToSupplier,
            reference: dto.transferRef,
            metadata: { commission: order.escrow.commission, net: order.escrow.netToSupplier, note: dto.note, confirmedManuallyByAdmin: true },
          },
        },
      },
    });

    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });

    const supplierUser = await this.prisma.user.findFirst({ where: { company: { id: order.supplierCompanyId } } });
    if (supplierUser) {
      await this.notifications.send(
        supplierUser.id, 'ESCROW_RELEASED',
        'تم تحويل مستحقاتك!',
        `تم تحويل ${order.escrow.netToSupplier.toLocaleString()} ج.م لحسابك البنكي — مرجع التحويل: ${dto.transferRef}.`,
        { orderId, amount: order.escrow.netToSupplier },
      );
    }

    this.logger.log(`Escrow manually released: Order ${orderId}, Net: ${order.escrow.netToSupplier} EGP, ref ${dto.transferRef}`);
    return escrow;
  }

  // ── ADMIN: escrows needing action (declared-but-unconfirmed funds, or payout-due) ──
  async listPendingActions() {
    const [awaitingFundConfirm, awaitingPayout] = await Promise.all([
      this.prisma.escrow.findMany({
        where: { status: 'PENDING', fundDeclaredAt: { not: null } },
        include: { order: { include: { buyer: { select: { nameAr: true } }, supplier: { select: { nameAr: true } } } } },
        orderBy: { fundDeclaredAt: 'asc' },
      }),
      this.prisma.escrow.findMany({
        where: { status: 'HELD', buyerConfirmedAt: { not: null } },
        include: { order: { include: { buyer: { select: { nameAr: true } }, supplier: { select: { nameAr: true } } } } },
        orderBy: { buyerConfirmedAt: 'asc' },
      }),
    ]);
    return { awaitingFundConfirm, awaitingPayout };
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

    await this.notifyDisputeParties(order, disputeRecord.id);

    return { escrow, dispute: disputeRecord };
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private async notifyAdmins(type: string, title: string, body: string, data?: any) {
    const admins = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
    for (const admin of admins) {
      await this.notifications.send(admin.id, type, title, body, data);
    }
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
