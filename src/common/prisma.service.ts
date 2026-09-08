// ─── common/prisma.service.ts ─────────────────────────────────────
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    // Log slow queries (>500ms)
    this.$on('query' as never, (e: any) => {
      if (e.duration > 500) {
        this.logger.warn(`Slow query (${e.duration}ms): ${e.query.slice(0, 100)}`);
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected ✓');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  // ── SOFT DELETE HELPER ─────────────────────────────────────────
  async softDelete(model: string, id: string) {
    return (this as any)[model].update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ── TRANSACTION HELPER ─────────────────────────────────────────
  async runTransaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(fn as any) as Promise<T>;
  }

  // ── PAGINATION HELPER ─────────────────────────────────────────
  paginate(page = 1, limit = 20) {
    return { skip: (page - 1) * limit, take: limit };
  }
}
