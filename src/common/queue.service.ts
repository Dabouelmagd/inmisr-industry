// ─── queue/queue.service.ts ───────────────────────────────────────
// RabbitMQ async event queue — decouples heavy operations from request cycle

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';
import { PrismaService } from '../common/prisma.service';

// ── EVENT DEFINITIONS ─────────────────────────────────────────────
export enum QueueEvent {
  // Verification
  VERIFY_DOCUMENT      = 'verify.document',
  // Search index sync
  INDEX_SUPPLIER       = 'index.supplier',
  INDEX_PRODUCT        = 'index.product',
  // Notifications
  SEND_NOTIFICATION    = 'notification.send',
  SEND_EMAIL           = 'notification.email',
  SEND_SMS             = 'notification.sms',
  SEND_PUSH            = 'notification.push',
  // Reports
  GENERATE_REPORT      = 'report.generate',
  GENERATE_FEASIBILITY = 'feasibility.generate',
  // Loyalty
  UPDATE_LOYALTY_POINTS = 'loyalty.update',
  // Recurring discount check
  CHECK_DISCOUNT        = 'discount.check',
}

const QUEUES = {
  VERIFICATION:   'inmisr.verification',
  SEARCH:         'inmisr.search',
  NOTIFICATIONS:  'inmisr.notifications',
  REPORTS:        'inmisr.reports',
  LOYALTY:        'inmisr.loyalty',
} as const;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection:  amqp.ChannelModel | null = null;
  private channel:     amqp.Channel | null    = null;
  private isConnected  = false;

  constructor(
    private config:        ConfigService,
    private notifications: NotificationsService,
    private search:        SearchService,
    private prisma:        PrismaService,
  ) {}

  async onModuleInit() {
    await this.connect();
    await this.startConsumers();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  // ── CONNECT ───────────────────────────────────────────────────
  private async connect() {
    const url = this.config.get('RABBITMQ_URL', 'amqp://localhost:5672');
    try {
      this.connection = await amqp.connect(url);
      this.channel    = await this.connection.createChannel();

      // Assert all queues as durable (survive broker restart)
      for (const queue of Object.values(QUEUES)) {
        await this.channel.assertQueue(queue, {
          durable:   true,
          arguments: {
            'x-dead-letter-exchange': 'inmisr.dlx', // Dead letter queue
            'x-message-ttl': 86400000,               // 24h TTL
          },
        });
      }

      // Prefetch — process 1 message at a time per consumer
      this.channel.prefetch(1);

      this.isConnected = true;
      this.logger.log('RabbitMQ connected ✓');

      this.connection.on('error', () => setTimeout(() => this.connect(), 5000));
      this.connection.on('close', () => { this.isConnected = false; setTimeout(() => this.connect(), 5000); });
    } catch (err) {
      this.logger.warn(`RabbitMQ unavailable — async features degraded: ${err.message}`);
      setTimeout(() => this.connect(), 10000);
    }
  }

  private async disconnect() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {}
  }

  // ── PUBLISH ───────────────────────────────────────────────────
  async publish(queue: string, event: QueueEvent, payload: any): Promise<boolean> {
    if (!this.isConnected || !this.channel) {
      this.logger.warn(`Queue unavailable — processing ${event} inline`);
      await this.processInline(event, payload);
      return false;
    }

    const message = Buffer.from(JSON.stringify({
      event,
      payload,
      timestamp:   Date.now(),
      retryCount:  0,
    }));

    return this.channel.sendToQueue(queue, message, {
      persistent:    true,
      contentType:   'application/json',
      correlationId: payload.id || payload.orderId || payload.userId,
    });
  }

  // Shorthand publishers
  async publishVerifyDocument(verificationId: string, fileKey: string, docType: string) {
    return this.publish(QUEUES.VERIFICATION, QueueEvent.VERIFY_DOCUMENT, { verificationId, fileKey, docType });
  }

  async publishIndexSupplier(companyId: string) {
    return this.publish(QUEUES.SEARCH, QueueEvent.INDEX_SUPPLIER, { companyId });
  }

  async publishSendNotification(userId: string, type: string, title: string, body: string, data?: any) {
    return this.publish(QUEUES.NOTIFICATIONS, QueueEvent.SEND_NOTIFICATION, { userId, type, title, body, data });
  }

  async publishUpdateLoyalty(companyId: string, orderId: string, amount: number) {
    return this.publish(QUEUES.LOYALTY, QueueEvent.UPDATE_LOYALTY_POINTS, { companyId, orderId, amount });
  }

  // ── CONSUMERS ─────────────────────────────────────────────────
  private async startConsumers() {
    if (!this.channel) return;

    // Verification consumer
    this.channel.consume(QUEUES.VERIFICATION, async (msg) => {
      if (!msg) return;
      try {
        const { event, payload } = JSON.parse(msg.content.toString());
        await this.handleVerification(payload);
        this.channel!.ack(msg);
      } catch (err) {
        this.logger.error('Verification consumer error', err.message);
        this.channel!.nack(msg, false, false); // Send to DLQ
      }
    });

    // Search index consumer
    this.channel.consume(QUEUES.SEARCH, async (msg) => {
      if (!msg) return;
      try {
        const { event, payload } = JSON.parse(msg.content.toString());
        if (event === QueueEvent.INDEX_SUPPLIER) {
          await this.search.indexSupplier(payload.companyId);
        }
        this.channel!.ack(msg);
      } catch (err) {
        this.logger.error('Search consumer error', err.message);
        this.channel!.nack(msg, false, true); // Requeue once
      }
    });

    // Notification consumer
    this.channel.consume(QUEUES.NOTIFICATIONS, async (msg) => {
      if (!msg) return;
      try {
        const { payload } = JSON.parse(msg.content.toString());
        await this.notifications.send(payload.userId, payload.type, payload.title, payload.body, payload.data);
        this.channel!.ack(msg);
      } catch (err) {
        this.logger.error('Notification consumer error', err.message);
        this.channel!.nack(msg, false, false);
      }
    });

    // Loyalty consumer
    this.channel.consume(QUEUES.LOYALTY, async (msg) => {
      if (!msg) return;
      try {
        const { payload } = JSON.parse(msg.content.toString());
        await this.handleLoyaltyUpdate(payload);
        this.channel!.ack(msg);
      } catch (err) {
        this.logger.error('Loyalty consumer error', err.message);
        this.channel!.nack(msg, false, false);
      }
    });

    this.logger.log('All RabbitMQ consumers started ✓');
  }

  // ── HANDLERS ──────────────────────────────────────────────────
  private async handleVerification(payload: any) {
    this.logger.log(`Processing verification: ${payload.verificationId}`);
    // OCR processing would happen here (AWS Textract call)
    // For now: mark as under review after 5 minutes simulation
    await this.prisma.verification.update({
      where: { id: payload.verificationId },
      data:  { status: 'UNDER_REVIEW' },
    });
  }

  private async handleLoyaltyUpdate(payload: { companyId: string; orderId: string; amount: number }) {
    const pointsEarned = Math.floor(payload.amount / 100); // 1 point per 100 EGP

    await this.prisma.loyaltyPoints.upsert({
      where:  { companyId: payload.companyId },
      create: {
        companyId:     payload.companyId,
        points:        pointsEarned,
        totalEarned:   pointsEarned,
        totalRedeemed: 0,
        transactionsJson: [{ orderId: payload.orderId, points: pointsEarned, at: new Date() }],
      },
      update: {
        points:       { increment: pointsEarned },
        totalEarned:  { increment: pointsEarned },
        lastUpdated:  new Date(),
      },
    });

    this.logger.log(`Loyalty: +${pointsEarned} points for company ${payload.companyId}`);

    // Check for recurring order discount
    const orderCount = await this.prisma.order.count({
      where: { buyerCompanyId: payload.companyId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    });

    let discountPct = 0;
    if (orderCount >= 20) discountPct = 15;
    else if (orderCount >= 10) discountPct = 10;
    else if (orderCount >= 3)  discountPct = 5;

    if (discountPct > 0) {
      const user = await this.prisma.user.findFirst({ where: { company: { id: payload.companyId } } });
      if (user) {
        await this.notifications.send(
          user.id, 'SYSTEM',
          `خصم ${discountPct}٪ على طلبك القادم`,
          `أنت مؤهل لخصم ${discountPct}٪ بناءً على ${orderCount} طلبات ناجحة. سيُطبق تلقائياً على طلبك القادم.`,
          { discountPct, orderCount },
        );
      }
    }
  }

  // ── INLINE FALLBACK (when RabbitMQ unavailable) ───────────────
  private async processInline(event: QueueEvent, payload: any) {
    switch (event) {
      case QueueEvent.INDEX_SUPPLIER:
        await this.search.indexSupplier(payload.companyId).catch(() => {});
        break;
      case QueueEvent.UPDATE_LOYALTY_POINTS:
        await this.handleLoyaltyUpdate(payload).catch(() => {});
        break;
    }
  }
}
