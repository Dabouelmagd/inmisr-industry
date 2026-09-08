// ─── filters/exception.filter.ts ─────────────────────────────────
import {
  ExceptionFilter, Catch, ArgumentsHost, HttpException,
  HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx  = host.switchToHttp();
    const res  = ctx.getResponse<Response>();
    const req  = ctx.getRequest<Request>();

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'حدث خطأ في الخادم — يرجى المحاولة مرة أخرى';
    let errors: any[] | undefined;
    let code    = 'INTERNAL_ERROR';

    // ── NestJS HTTP exceptions ─────────────────────────────────
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;

      if (typeof body === 'string') {
        message = body;
      } else if (body.message) {
        if (Array.isArray(body.message)) {
          // Validation errors from class-validator
          errors  = body.message.map((m: string) => this.translateValidation(m));
          message = 'بيانات غير صحيحة — يرجى مراجعة الحقول المطلوبة';
        } else {
          message = body.message;
        }
      }
      code = body.error || HttpStatus[status];
    }

    // ── Prisma database errors ─────────────────────────────────
    else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          status  = HttpStatus.CONFLICT;
          message = this.buildUniqueError(exception.meta?.target);
          code    = 'DUPLICATE_ENTRY';
          break;
        case 'P2025':
          status  = HttpStatus.NOT_FOUND;
          message = 'السجل المطلوب غير موجود';
          code    = 'NOT_FOUND';
          break;
        case 'P2003':
          status  = HttpStatus.BAD_REQUEST;
          message = 'مرجع غير صالح — تأكد من صحة البيانات المرسلة';
          code    = 'FOREIGN_KEY_ERROR';
          break;
        case 'P2014':
          status  = HttpStatus.BAD_REQUEST;
          message = 'لا يمكن حذف هذا السجل لوجود بيانات مرتبطة به';
          code    = 'RELATION_VIOLATION';
          break;
        default:
          this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);
      }
    }

    else if (exception instanceof Prisma.PrismaClientValidationError) {
      status  = HttpStatus.BAD_REQUEST;
      message = 'بيانات غير صحيحة في الطلب';
      code    = 'VALIDATION_ERROR';
    }

    // ── Unknown errors ─────────────────────────────────────────
    else {
      this.logger.error(
        `Unhandled exception on ${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // ── Build response ─────────────────────────────────────────
    const response = {
      success:   false,
      error:     code,
      message,
      ...(errors && { errors }),
      path:      req.url,
      timestamp: new Date().toISOString(),
    };

    // Don't expose internals in production
    if (process.env.NODE_ENV !== 'production' && exception instanceof Error) {
      (response as any).debug = exception.message;
    }

    res.status(status).json(response);
  }

  private buildUniqueError(target: any): string {
    const field = Array.isArray(target) ? target[0] : String(target || '');
    const fieldMap: Record<string, string> = {
      email:            'البريد الإلكتروني مسجل بالفعل',
      phone_hash:       'رقم الهاتف مسجل بالفعل',
      commercial_reg_no:'رقم السجل التجاري مسجل بالفعل',
      tax_id:           'الرقم الضريبي مسجل بالفعل',
    };
    return fieldMap[field] || `القيمة المدخلة مكررة في الحقل: ${field}`;
  }

  private translateValidation(msg: string): string {
    const translations: Record<string, string> = {
      'must be a string':      'يجب أن يكون نصاً',
      'must be a number':      'يجب أن يكون رقماً',
      'should not be empty':   'هذا الحقل مطلوب',
      'must be an email':      'يجب أن يكون بريداً إلكترونياً صحيحاً',
      'must be a valid enum':  'قيمة غير صالحة',
      'must be a URL':         'يجب أن يكون رابطاً صحيحاً',
      'must be a UUID':        'معرّف غير صحيح',
      'must be a date string': 'يجب أن يكون تاريخاً صحيحاً',
      'must not be less than': 'القيمة أقل من الحد الأدنى المسموح',
      'must not be greater':   'القيمة تتجاوز الحد الأقصى المسموح',
    };
    for (const [en, ar] of Object.entries(translations)) {
      if (msg.toLowerCase().includes(en.toLowerCase())) return ar;
    }
    return msg;
  }
}
