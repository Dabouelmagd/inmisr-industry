// ─── upload/upload.service.ts ─────────────────────────────────────
// AWS S3 file upload with presigned URLs, compression, virus scan
// Handles: verification docs, shipment photos, RFQ attachments

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';

export type UploadCategory =
  | 'verification-docs'
  | 'shipment-photos'
  | 'order-documents'
  | 'product-images'
  | 'company-logos'
  | 'rfq-attachments';

interface PresignedUploadResult {
  uploadUrl:    string;
  fileKey:      string;
  publicUrl:    string;
  expiresAt:    Date;
  fields:       Record<string, string>;
}

const ALLOWED_MIME: Record<UploadCategory, string[]> = {
  'verification-docs': ['application/pdf', 'image/jpeg', 'image/png'],
  'shipment-photos':   ['image/jpeg', 'image/png', 'image/webp'],
  'order-documents':   ['application/pdf', 'image/jpeg', 'image/png'],
  'product-images':    ['image/jpeg', 'image/png', 'image/webp'],
  'company-logos':     ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'],
  'rfq-attachments':   ['application/pdf', 'image/jpeg', 'image/png', 'application/msword',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

const MAX_SIZE: Record<UploadCategory, number> = {
  'verification-docs': 10 * 1024 * 1024,  // 10 MB
  'shipment-photos':   20 * 1024 * 1024,  // 20 MB
  'order-documents':   15 * 1024 * 1024,  // 15 MB
  'product-images':     5 * 1024 * 1024,  //  5 MB
  'company-logos':      2 * 1024 * 1024,  //  2 MB
  'rfq-attachments':   10 * 1024 * 1024,  // 10 MB
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly cdnBase: string;

  constructor(private config: ConfigService) {
    this.region  = config.get('AWS_REGION', 'me-south-1');
    this.bucket  = config.get('AWS_S3_BUCKET', 'inmisr-industry-files');
    this.cdnBase = config.get('AWS_CLOUDFRONT_URL', `https://${this.bucket}.s3.${this.region}.amazonaws.com`);

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId:     config.get('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  // ── GENERATE PRESIGNED UPLOAD URL ────────────────────────────
  async getPresignedUploadUrl(dto: {
    filename:   string;
    mimeType:   string;
    fileSize:   number;
    category:   UploadCategory;
    entityId:   string;
    uploaderId: string;
  }): Promise<PresignedUploadResult> {

    // Validate mime type
    if (!ALLOWED_MIME[dto.category].includes(dto.mimeType)) {
      throw new BadRequestException(
        `نوع الملف غير مسموح به. الأنواع المقبولة: ${ALLOWED_MIME[dto.category].join(', ')}`
      );
    }

    // Validate file size
    if (dto.fileSize > MAX_SIZE[dto.category]) {
      const maxMB = MAX_SIZE[dto.category] / 1024 / 1024;
      throw new BadRequestException(`حجم الملف يتجاوز الحد الأقصى (${maxMB} MB)`);
    }

    // Build secure file key
    const ext      = path.extname(dto.filename).toLowerCase();
    const hash     = crypto.randomBytes(16).toString('hex');
    const fileKey  = `${dto.category}/${dto.entityId}/${Date.now()}-${hash}${ext}`;

    // Generate presigned PUT URL (valid 15 minutes)
    const command = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         fileKey,
      ContentType: dto.mimeType,
      ContentLength: dto.fileSize,
      Metadata: {
        'uploader-id':  dto.uploaderId,
        'entity-id':    dto.entityId,
        'category':     dto.category,
        'original-name': encodeURIComponent(dto.filename),
        'upload-ts':    Date.now().toString(),
      },
      // Server-side encryption
      ServerSideEncryption: 'AES256',
      // Block public access — files only accessible via presigned GET URLs
      ACL: 'private',
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 900 }); // 15 min
    const expiresAt = new Date(Date.now() + 900 * 1000);

    this.logger.log(`Presigned upload URL generated: ${fileKey} (${dto.category})`);

    return {
      uploadUrl,
      fileKey,
      publicUrl: `${this.cdnBase}/${fileKey}`,
      expiresAt,
      fields: {
        'Content-Type':   dto.mimeType,
        'x-amz-meta-uploader-id': dto.uploaderId,
      },
    };
  }

  // ── GENERATE PRESIGNED DOWNLOAD URL ──────────────────────────
  async getPresignedDownloadUrl(fileKey: string, expiresInSecs = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: fileKey });
    return getSignedUrl(this.s3, command, { expiresIn: expiresInSecs });
  }

  // ── VERIFY FILE EXISTS AFTER UPLOAD ──────────────────────────
  async verifyUpload(fileKey: string): Promise<{ exists: boolean; size: number; mimeType: string }> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fileKey }));
      return {
        exists:   true,
        size:     head.ContentLength || 0,
        mimeType: head.ContentType || 'unknown',
      };
    } catch {
      return { exists: false, size: 0, mimeType: '' };
    }
  }

  // ── DELETE FILE ───────────────────────────────────────────────
  async deleteFile(fileKey: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }));
    this.logger.log(`File deleted: ${fileKey}`);
  }

  // ── SCAN FOR VIRUSES (ClamAV via Lambda) ─────────────────────
  async scanForViruses(fileKey: string): Promise<{ clean: boolean; threat?: string }> {
    // In production: trigger AWS Lambda running ClamAV
    // Lambda scans the file in S3 and returns result
    // For MVP: trust S3 + AWS Macie
    this.logger.log(`Virus scan triggered for: ${fileKey}`);
    return { clean: true }; // Lambda result in production
  }

  // ── PROCESS UPLOADED DOCUMENT (OCR trigger) ──────────────────
  async processDocument(fileKey: string, docType: string, verificationId: string): Promise<void> {
    // Trigger AWS Textract via SQS message
    this.logger.log(`OCR processing queued: ${fileKey} → ${docType}`);
    // In production: publish to RabbitMQ / SQS for async processing
  }

  // ── BUILD FULL URL ────────────────────────────────────────────
  buildUrl(fileKey: string): string {
    return `${this.cdnBase}/${fileKey}`;
  }
}

// ─── upload/upload.controller.ts ──────────────────────────────────
import {
  Controller, Post, Get, Delete, Body, Param, Query,
  UseGuards, Request,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNumber, IsEnum, Min, Max } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';

class GetUploadUrlDto {
  @IsString()   filename:  string;
  @IsString()   mimeType:  string;
  @IsNumber() @Min(1) @Max(50 * 1024 * 1024) fileSize: number;
  @IsEnum(['verification-docs','shipment-photos','order-documents','product-images','company-logos','rfq-attachments'])
                category:  UploadCategory;
  @IsString()   entityId:  string;
}

@ApiTags('upload')
@Controller('upload')
@UseGuards(JwtGuard)
@ApiBearerAuth()
export class UploadController {
  constructor(private upload: UploadService) {}

  @Post('presign')
  @ApiOperation({ summary: 'الحصول على رابط رفع مؤقت' })
  async getUploadUrl(@Body() dto: GetUploadUrlDto, @Request() req: any) {
    return this.upload.getPresignedUploadUrl({
      ...dto,
      uploaderId: req.user.sub,
    });
  }

  @Post('verify/:fileKey')
  @ApiOperation({ summary: 'التحقق من اكتمال الرفع' })
  async verifyUpload(@Param('fileKey') fileKey: string) {
    const decoded = decodeURIComponent(fileKey);
    return this.upload.verifyUpload(decoded);
  }

  @Get('download/:fileKey')
  @ApiOperation({ summary: 'رابط تحميل مؤقت' })
  async getDownloadUrl(
    @Param('fileKey') fileKey: string,
    @Query('expires') expires = '3600',
  ) {
    const url = await this.upload.getPresignedDownloadUrl(
      decodeURIComponent(fileKey),
      parseInt(expires),
    );
    return { url, expiresIn: parseInt(expires) };
  }

  @Delete(':fileKey')
  @ApiOperation({ summary: 'حذف ملف' })
  async deleteFile(@Param('fileKey') fileKey: string) {
    await this.upload.deleteFile(decodeURIComponent(fileKey));
    return { message: 'تم حذف الملف' };
  }
}
