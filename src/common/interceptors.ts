// ─── interceptors/index.ts ────────────────────────────────────────
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
  Logger, RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, map, tap, timeout } from 'rxjs/operators';
import { Request } from 'express';

// ── Response Transform Interceptor ───────────────────────────────
// Wraps all responses in { success, data, timestamp }
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map(data => ({
        success:   true,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}

// ── Logging Interceptor ───────────────────────────────────────────
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req    = ctx.switchToHttp().getRequest<Request>();
    const method = req.method;
    const url    = req.url;
    const userIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userId = (req as any).user?.sub || 'anonymous';
    const start  = Date.now();

    return next.handle().pipe(
      tap((data) => {
        const ms  = Date.now() - start;
        const res = ctx.switchToHttp().getResponse();
        this.logger.log(`${method} ${url} ${res.statusCode} ${ms}ms [${userId}] [${userIp}]`);
        // Log slow requests
        if (ms > 1000) {
          this.logger.warn(`Slow request: ${method} ${url} — ${ms}ms`);
        }
      }),
      catchError(err => {
        const ms = Date.now() - start;
        this.logger.error(`${method} ${url} ERROR ${ms}ms [${userId}]: ${err.message}`);
        throw err;
      }),
    );
  }
}

// ── Timeout Interceptor ───────────────────────────────────────────
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs = 30000) {}

  intercept(_: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError(err => {
        if (err instanceof TimeoutError) {
          throw new RequestTimeoutException('انتهت مهلة الطلب — يرجى المحاولة مرة أخرى');
        }
        return throwError(() => err);
      }),
    );
  }
}

// ── Cache Busting Interceptor ─────────────────────────────────────
// Adds cache headers to GET responses
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse();

    return next.handle().pipe(
      tap(() => {
        if (req.method === 'GET') {
          // Public endpoints get short cache
          if (req.url.includes('/categories') || req.url.includes('/geo/zones')) {
            res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
          } else if (req.url.includes('/suppliers') || req.url.includes('/products')) {
            res.setHeader('Cache-Control', 'public, max-age=60');  // 1 min
          } else {
            res.setHeader('Cache-Control', 'no-store');
          }
        } else {
          res.setHeader('Cache-Control', 'no-store');
        }
      }),
    );
  }
}
