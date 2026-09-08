// ─── websocket/websocket.gateway.ts ──────────────────────────────
// Real-time WebSocket using Socket.io + NestJS Gateways
// Handles: live notifications, order status updates, secure messaging

import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  ConnectedSocket, MessageBody, WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { AntiLeakageService } from '../common/anti-leakage.service';
import { Server, Socket } from 'socket.io';

// ── EVENT TYPES ───────────────────────────────────────────────────
export enum WsEvent {
  // Client → Server
  JOIN_ORDER_ROOM    = 'join:order',
  LEAVE_ORDER_ROOM   = 'leave:order',
  SEND_MESSAGE       = 'message:send',
  TYPING             = 'message:typing',
  MARK_READ          = 'message:read',

  // Server → Client
  NOTIFICATION       = 'notification',
  ORDER_UPDATE       = 'order:update',
  ESCROW_UPDATE      = 'escrow:update',
  MESSAGE_RECEIVED   = 'message:received',
  MESSAGE_REDACTED   = 'message:redacted',
  USER_TYPING        = 'user:typing',
  CONNECTION_ACK     = 'connection:ack',
  ERROR              = 'error',
}

interface AuthenticatedSocket extends Socket {
  userId:    string;
  companyId: string;
  role:      string;
}

@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: Function) => {
      const allowed = ['https://inmisr.net', 'https://www.inmisr.net', 'http://localhost:3000'];
      callback(null, allowed.includes(origin));
    },
    credentials: true,
  },
  namespace: '/',
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout:  60000,
})
export class InMisrWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {

  @WebSocketServer() server: Server;
  private readonly logger = new Logger(InMisrWebSocketGateway.name);

  // userId → Set<socketId> map for targeting specific users
  private userSockets = new Map<string, Set<string>>();

  constructor(
    private jwt:         JwtService,
    private config:      ConfigService,
    private prisma:      PrismaService,
    private antiLeakage: AntiLeakageService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');

    // JWT auth middleware
    server.use(async (socket: any, next) => {
      try {
        const token = socket.handshake.auth?.token ||
                      socket.handshake.headers?.authorization?.split(' ')[1];

        if (!token) return next(new WsException('Authentication required'));

        const payload = await this.jwt.verifyAsync(token, {
          secret: this.config.get('JWT_ACCESS_SECRET'),
        });

        socket.userId    = payload.sub;
        socket.companyId = payload.companyId;
        socket.role      = payload.role;
        next();
      } catch {
        next(new WsException('Invalid or expired token'));
      }
    });
  }

  async handleConnection(client: AuthenticatedSocket) {
    const { userId } = client;
    if (!userId) return;

    // Track socket
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(client.id);

    // Auto-join user's personal notification room
    client.join(`user:${userId}`);

    // Send pending notifications count
    const unread = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });

    client.emit(WsEvent.CONNECTION_ACK, {
      userId,
      unreadNotifications: unread,
      connectedAt: new Date().toISOString(),
    });

    this.logger.log(`Client connected: ${userId} (socket: ${client.id})`);
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const { userId } = client;
    if (!userId) return;

    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) this.userSockets.delete(userId);
    }

    this.logger.log(`Client disconnected: ${userId}`);
  }

  // ── JOIN ORDER ROOM ───────────────────────────────────────────
  @SubscribeMessage(WsEvent.JOIN_ORDER_ROOM)
  async handleJoinOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      include: {
        buyer:    { include: { user: { select: { id: true } } } },
        supplier: { include: { user: { select: { id: true } } } },
      },
    });

    if (!order) return { error: 'Order not found' };

    const isParty = order.buyer?.user?.id    === client.userId ||
                    order.supplier?.user?.id === client.userId;
    const isAdmin = client.role === 'ADMIN' || client.role === 'SUPER_ADMIN';

    if (!isParty && !isAdmin) {
      return { error: 'Access denied' };
    }

    client.join(`order:${data.orderId}`);
    this.logger.log(`User ${client.userId} joined order room: ${data.orderId}`);
    return { joined: true };
  }

  @SubscribeMessage(WsEvent.LEAVE_ORDER_ROOM)
  handleLeaveOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ) {
    client.leave(`order:${data.orderId}`);
  }

  // ── SEND MESSAGE ──────────────────────────────────────────────
  @SubscribeMessage(WsEvent.SEND_MESSAGE)
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string; content: string; attachments?: any[] },
  ) {
    if (!data.content?.trim()) return { error: 'Empty message' };
    if (data.content.length > 2000) return { error: 'Message too long (max 2000 chars)' };

    // Anti-leakage filter
    const filtered = this.antiLeakage.sanitize(data.content);

    const message = await this.prisma.message.create({
      data: {
        senderId:          client.userId,
        orderId:           data.orderId,
        contentEncrypted:  Buffer.from(data.content).toString('base64'),
        contentSanitized:  filtered.sanitized,
        hasPiiFlag:        filtered.hasPii,
        piiTypes:          filtered.piiTypes,
        isRedacted:        filtered.hasPii,
        attachmentsJson:   data.attachments || [],
      },
      include: {
        sender: { select: { id: true, company: { select: { nameAr: true } } } },
      },
    });

    const response = {
      id:          message.id,
      orderId:     data.orderId,
      senderId:    client.userId,
      senderName:  message.sender.company?.nameAr || 'Unknown',
      content:     filtered.sanitized,
      hasPii:      filtered.hasPii,
      piiTypes:    filtered.piiTypes,
      attachments: data.attachments || [],
      createdAt:   message.createdAt,
    };

    // Broadcast to order room (both buyer and supplier)
    this.server.to(`order:${data.orderId}`).emit(WsEvent.MESSAGE_RECEIVED, response);

    // If PII was detected, send extra warning to sender only
    if (filtered.hasPii) {
      client.emit(WsEvent.MESSAGE_REDACTED, {
        messageId: message.id,
        piiTypes:  filtered.piiTypes,
        warning:   `تم حذف ${filtered.piiTypes.join('، ')} من رسالتك تلقائياً`,
      });

      // Log leakage attempt
      await this.antiLeakage.processMessage(
        data.content, client.userId, data.orderId, message.id,
      );
    }

    return { sent: true, messageId: message.id };
  }

  // ── TYPING INDICATOR ──────────────────────────────────────────
  @SubscribeMessage(WsEvent.TYPING)
  handleTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string; isTyping: boolean },
  ) {
    client.to(`order:${data.orderId}`).emit(WsEvent.USER_TYPING, {
      userId:    client.userId,
      isTyping:  data.isTyping,
    });
  }

  // ── MARK MESSAGES READ ────────────────────────────────────────
  @SubscribeMessage(WsEvent.MARK_READ)
  async handleMarkRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ) {
    await this.prisma.message.updateMany({
      where: { orderId: data.orderId, senderId: { not: client.userId }, readAt: null },
      data:  { readAt: new Date() },
    });
  }

  // ── SERVER-SIDE EMIT HELPERS (called by other services) ───────
  emitToUser(userId: string, event: WsEvent, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitNotification(userId: string, notification: any) {
    this.emitToUser(userId, WsEvent.NOTIFICATION, notification);
  }

  emitOrderUpdate(orderId: string, update: any) {
    this.server.to(`order:${orderId}`).emit(WsEvent.ORDER_UPDATE, update);
  }

  emitEscrowUpdate(orderId: string, update: any) {
    this.server.to(`order:${orderId}`).emit(WsEvent.ESCROW_UPDATE, update);
  }

  isUserOnline(userId: string): boolean {
    return (this.userSockets.get(userId)?.size || 0) > 0;
  }

  getOnlineCount(): number {
    return this.userSockets.size;
  }
}
