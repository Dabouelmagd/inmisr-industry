// ─── notifications/notifications.service.ts ──────────────────────
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import axios from 'axios';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;
  private fromEmail: string;
  private fromName: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    if (!host || !user || !pass) {
      this.logger.warn('متغيرات SMTP غير مكتملة (SMTP_HOST/SMTP_USER/SMTP_PASS) — الإيميلات لن تُرسل حتى تُضاف لملف .env');
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT', 465),
      secure: this.config.get<number>('SMTP_PORT', 465) === 465, // true for port 465 (SSL), false for 587 (TLS)
      auth: { user, pass },
    });

    this.fromEmail = this.config.get<string>('SMTP_FROM_EMAIL', user || 'noreply@inmisr.net');
    this.fromName  = this.config.get<string>('SMTP_FROM_NAME', 'إن مصر للصناعة');
  }

  // ── IN-APP NOTIFICATION ───────────────────────────────────────
  async send(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: any,
  ) {
    try {
      const notif = await this.prisma.notification.create({
        data: {
          userId, titleAr, bodyAr,
          type: type as any,
          data: data || {},
          channels: ['IN_APP'],
        },
      });

      // Get user preferences and route to channels
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, phoneHash: true, phoneRelay: true },
      });

      // Always push to in-app (WebSocket in production)
      this.logger.log(`Notification sent to ${userId}: ${titleAr}`);

      return notif;
    } catch (err) {
      this.logger.error(`Failed to send notification to ${userId}`, err.message);
    }
  }

  // ── EMAIL ─────────────────────────────────────────────────────
  async sendEmail(to: string, subject: string, text: string, html?: string) {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to,
        subject,
        text,
        html: html || this.buildEmailTemplate(subject, text),
      });
      this.logger.log(`Email sent via SMTP to ${to}: ${subject}`);
    } catch (err) {
      this.logger.error(`SMTP email failed to ${to}`, err.message);
    }
  }

  private buildEmailTemplate(title: string, body: string): string {
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;direction:rtl">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden">
  <div style="background:#0D0F12;padding:20px 24px;display:flex;align-items:center;gap:12px">
    <div style="color:#D4A017;font-size:18px;font-weight:bold">إن مصر للصناعة</div>
    <div style="color:#999;font-size:12px">In Misr Industry</div>
  </div>
  <div style="padding:28px 24px">
    <h2 style="color:#1a1a1a;font-size:20px;margin:0 0 16px">${title}</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 24px">${body}</p>
    <div style="text-align:center;margin-top:24px">
      <a href="https://inmisr.net/dashboard" style="background:#D4A017;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">
        فتح المنصة
      </a>
    </div>
  </div>
  <div style="background:#f8f8f8;padding:16px 24px;text-align:center;border-top:1px solid #eee">
    <p style="color:#999;font-size:11px;margin:0">© 2026 إن مصر للصناعة | inmisr.net</p>
    <p style="color:#ccc;font-size:10px;margin:4px 0 0">للإلغاء الاشتراك في الإشعارات، تفضل بزيارة إعدادات حسابك</p>
  </div>
</div>
</body>
</html>`;
  }

  // ── SMS via Twilio ────────────────────────────────────────────
  async sendSms(phone: string, message: string) {
    try {
      const accountSid = this.config.get('TWILIO_ACCOUNT_SID');
      const authToken  = this.config.get('TWILIO_AUTH_TOKEN');
      const from       = this.config.get('TWILIO_FROM_NUMBER');

      const response = await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        new URLSearchParams({ Body: message, From: from, To: phone }),
        { auth: { username: accountSid, password: authToken } },
      );

      this.logger.log(`SMS sent to ${phone.slice(-4).padStart(phone.length, '*')}`);
      return response.data;
    } catch (err) {
      this.logger.error(`SMS failed to ${phone.slice(-4).padStart(4, '*')}`, err.message);
    }
  }

  // ── PUSH via Firebase FCM ─────────────────────────────────────
  async sendPush(deviceToken: string, title: string, body: string, data?: any) {
    try {
      const fcmKey = this.config.get('FCM_SERVER_KEY');
      await axios.post(
        'https://fcm.googleapis.com/fcm/send',
        {
          to: deviceToken,
          notification: { title, body, sound: 'default', badge: '1' },
          data: data || {},
          priority: 'high',
        },
        { headers: { Authorization: `key=${fcmKey}`, 'Content-Type': 'application/json' } },
      );
      this.logger.log(`Push sent: ${title}`);
    } catch (err) {
      this.logger.error('Push notification failed', err.message);
    }
  }

  // ── BULK NOTIFICATION ─────────────────────────────────────────
  async sendBulk(userIds: string[], type: string, titleAr: string, bodyAr: string, data?: any) {
    const batch = userIds.map(userId =>
      this.prisma.notification.create({ data: { userId, type: type as any, titleAr, bodyAr, data: data || {}, channels: ['IN_APP'] } })
    );
    await Promise.allSettled(batch);
    this.logger.log(`Bulk notification sent to ${userIds.length} users: ${titleAr}`);
  }

  // ── GET USER NOTIFICATIONS ────────────────────────────────────
  async getUserNotifications(userId: string, page = 1, limit = 20) {
    const [data, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { data, total, unread, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async markAsRead(notificationId: string, userId: string) {
    return this.prisma.notification.update({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }
}
