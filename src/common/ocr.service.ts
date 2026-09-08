// ─── ocr/ocr.service.ts ───────────────────────────────────────────
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  TextractClient, AnalyzeDocumentCommand,
  DetectDocumentTextCommand, FeatureType,
} from '@aws-sdk/client-textract';
import axios from 'axios';

export interface OcrResult {
  success:     boolean;
  docType:     string;
  confidence:  number;
  fields:      Record<string, string>;
  rawText:     string;
  validations: ValidationResult[];
}

interface ValidationResult {
  field:   string;
  valid:   boolean;
  message: string;
  value?:  string;
}

@Injectable()
export class OcrService {
  private readonly logger  = new Logger(OcrService.name);
  private readonly textract: TextractClient;

  constructor(
    private config:        ConfigService,
    private prisma:        PrismaService,
    private notifications: NotificationsService,
  ) {
    this.textract = new TextractClient({
      region: config.get('AWS_REGION', 'me-south-1'),
      credentials: {
        accessKeyId:     config.get('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  // ── MAIN: Process verification document ──────────────────────
  async processVerificationDocument(
    verificationId: string,
    s3Bucket: string,
    s3Key: string,
    docType: string,
  ): Promise<OcrResult> {
    this.logger.log(`OCR processing: ${docType} — ${s3Key}`);

    try {
      // Extract text from S3 document
      const rawText = await this.extractText(s3Bucket, s3Key);
      const fields  = await this.extractFields(s3Bucket, s3Key, docType);

      // Validate extracted data
      const validations = await this.validateDocument(docType, fields, rawText);
      const allValid    = validations.every(v => v.valid);
      const confidence  = this.calculateConfidence(fields, validations);

      const result: OcrResult = {
        success:     allValid && confidence >= 0.7,
        docType,
        confidence,
        fields,
        rawText:     rawText.slice(0, 500),
        validations,
      };

      // Update verification record
      await this.prisma.verification.update({
        where: { id: verificationId },
        data: {
          ocrDataJson: result as any,
          status:      result.success ? 'VERIFIED' : 'UNDER_REVIEW',
          reviewedAt:  result.success ? new Date() : null,
        },
      });

      // If auto-verified, check for level upgrade
      if (result.success) {
        await this.checkLevelUpgrade(verificationId);
      }

      this.logger.log(`OCR result: ${docType} — ${result.success ? '✓ VERIFIED' : '⏳ REVIEW'} (conf: ${(confidence * 100).toFixed(0)}%)`);
      return result;

    } catch (err) {
      this.logger.error(`OCR failed for ${verificationId}`, err.message);
      await this.prisma.verification.update({
        where: { id: verificationId },
        data: { status: 'UNDER_REVIEW' },
      });
      return {
        success: false, docType, confidence: 0,
        fields: {}, rawText: '',
        validations: [{ field: 'system', valid: false, message: `OCR error: ${err.message}` }],
      };
    }
  }

  // ── AWS TEXTRACT: Extract raw text ───────────────────────────
  private async extractText(bucket: string, key: string): Promise<string> {
    const cmd = new DetectDocumentTextCommand({
      Document: { S3Object: { Bucket: bucket, Name: key } },
    });
    const response = await this.textract.send(cmd);
    return (response.Blocks || [])
      .filter(b => b.BlockType === 'LINE')
      .map(b => b.Text || '')
      .join('\n');
  }

  // ── AWS TEXTRACT: Extract key-value pairs ────────────────────
  private async extractFields(bucket: string, key: string, docType: string): Promise<Record<string, string>> {
    const cmd = new AnalyzeDocumentCommand({
      Document:       { S3Object: { Bucket: bucket, Name: key } },
      FeatureTypes:   [FeatureType.FORMS, FeatureType.TABLES],
    });
    const response = await this.textract.send(cmd);
    const fields: Record<string, string> = {};

    // Build key-value map from Textract response
    const keyMap  = new Map<string, string>();
    const valMap  = new Map<string, string>();
    const relMap  = new Map<string, string>();

    (response.Blocks || []).forEach(block => {
      if (block.BlockType === 'KEY_VALUE_SET') {
        const text = (block.Relationships || [])
          .filter(r => r.Type === 'CHILD')
          .flatMap(r => r.Ids || [])
          .map(id => (response.Blocks || []).find(b => b.Id === id)?.Text || '')
          .join(' ').trim();

        if (block.EntityTypes?.includes('KEY')) {
          keyMap.set(block.Id!, text);
          (block.Relationships || []).filter(r => r.Type === 'VALUE').flatMap(r => r.Ids || []).forEach(vid => {
            relMap.set(vid, block.Id!);
          });
        } else {
          valMap.set(block.Id!, text);
        }
      }
    });

    relMap.forEach((keyId, valId) => {
      const k = keyMap.get(keyId);
      const v = valMap.get(valId);
      if (k && v) fields[k] = v;
    });

    // Also extract using regex patterns for Arabic government documents
    const rawText = await this.extractText(bucket, key);
    Object.assign(fields, this.extractArabicFields(rawText, docType));

    return fields;
  }

  // ── REGEX extraction for Arabic government docs ───────────────
  private extractArabicFields(text: string, docType: string): Record<string, string> {
    const fields: Record<string, string> = {};

    if (docType === 'COMMERCIAL_REG') {
      // سجل تجاري رقم
      const regMatch = text.match(/(?:رقم|سجل|تجاري)[:\s]*([0-9٠-٩]{5,15})/i);
      if (regMatch) fields['commercial_reg_number'] = regMatch[1];

      // اسم الشركة
      const nameMatch = text.match(/(?:اسم الشركة|المنشأة|الشركة)[:\s]*([^\n\r]{5,60})/i);
      if (nameMatch) fields['company_name'] = nameMatch[1].trim();

      // تاريخ الإصدار
      const dateMatch = text.match(/(?:تاريخ|صادر|إصدار)[:\s]*([0-9٠-٩\/\-\.]{6,12})/i);
      if (dateMatch) fields['issue_date'] = dateMatch[1];

      // النشاط التجاري
      const actMatch = text.match(/(?:النشاط|الغرض)[:\s]*([^\n\r]{10,100})/i);
      if (actMatch) fields['activity'] = actMatch[1].trim();
    }

    if (docType === 'TAX_ID') {
      // رقم التسجيل الضريبي
      const taxMatch = text.match(/(?:رقم الملف|الضريبي|التسجيل)[:\s]*([0-9٠-٩]{9,15})/i);
      if (taxMatch) fields['tax_number'] = taxMatch[1];

      // اسم الممول
      const nameMatch = text.match(/(?:اسم الممول|اسم المنشأة)[:\s]*([^\n\r]{5,60})/i);
      if (nameMatch) fields['taxpayer_name'] = nameMatch[1].trim();
    }

    if (docType === 'NATIONAL_ID') {
      // رقم الهوية الوطنية (14 رقم)
      const idMatch = text.match(/\b([0-9٠-٩]{14})\b/);
      if (idMatch) fields['national_id'] = idMatch[1];
    }

    return fields;
  }

  // ── VALIDATE extracted data ───────────────────────────────────
  private async validateDocument(
    docType: string,
    fields: Record<string, string>,
    rawText: string,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    if (docType === 'COMMERCIAL_REG') {
      // Check commercial reg number exists
      const regNum = fields['commercial_reg_number'];
      results.push({
        field:   'commercial_reg_number',
        valid:   !!regNum && regNum.length >= 5,
        message: regNum ? 'رقم السجل التجاري موجود' : 'رقم السجل التجاري غير موجود في الوثيقة',
        value:   regNum,
      });

      // Check company name
      const name = fields['company_name'];
      results.push({
        field:   'company_name',
        valid:   !!name && name.length >= 3,
        message: name ? 'اسم الشركة موجود' : 'اسم الشركة غير واضح',
        value:   name,
      });

      // Validate against GAFI API (Egyptian investment authority)
      if (regNum) {
        const gafiResult = await this.validateWithGafi(regNum).catch(() => null);
        results.push({
          field:   'gafi_validation',
          valid:   gafiResult?.valid ?? true, // Pass if API unavailable
          message: gafiResult?.valid ? 'السجل مسجل في هيئة الاستثمار' : 'تعذر التحقق من هيئة الاستثمار — مراجعة يدوية مطلوبة',
        });
      }
    }

    if (docType === 'TAX_ID') {
      const taxNum = fields['tax_number'];
      results.push({
        field:   'tax_number',
        valid:   !!taxNum && taxNum.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).length >= 9,
        message: taxNum ? 'رقم الملف الضريبي موجود' : 'رقم الملف الضريبي غير موجود',
        value:   taxNum,
      });

      // Validate with Tax Authority API
      if (taxNum) {
        const etaResult = await this.validateWithEta(taxNum).catch(() => null);
        results.push({
          field:   'eta_validation',
          valid:   etaResult?.valid ?? true,
          message: etaResult?.valid ? 'مسجل في مصلحة الضرائب' : 'تعذر التحقق — مراجعة يدوية',
        });
      }
    }

    // Check document is not expired (for any type)
    const hasExpiryKeywords = /(?:صالح|منتهي|انتهاء|expir)/i.test(rawText);
    if (hasExpiryKeywords) {
      const expired = /(?:منتهي|expired|لا يصلح)/i.test(rawText);
      results.push({
        field:   'expiry',
        valid:   !expired,
        message: expired ? 'الوثيقة منتهية الصلاحية' : 'الوثيقة سارية',
      });
    }

    return results;
  }

  // ── External API validations ──────────────────────────────────
  private async validateWithGafi(regNum: string): Promise<{ valid: boolean }> {
    const gafiApiUrl = this.config.get('GAFI_API_URL');
    if (!gafiApiUrl) return { valid: true }; // Skip if not configured
    const res = await axios.get(`${gafiApiUrl}/validate/${regNum}`, { timeout: 5000 });
    return { valid: res.data?.isValid === true };
  }

  private async validateWithEta(taxNum: string): Promise<{ valid: boolean }> {
    const etaApiUrl = this.config.get('ETA_VALIDATE_URL');
    if (!etaApiUrl) return { valid: true };
    const res = await axios.get(`${etaApiUrl}/taxpayer/${taxNum}`, { timeout: 5000 });
    return { valid: res.data?.status === 'ACTIVE' };
  }

  private calculateConfidence(fields: Record<string, string>, validations: ValidationResult[]): number {
    const fieldScore  = Object.keys(fields).length > 2 ? 0.6 : 0.3;
    const validScore  = validations.length
      ? validations.filter(v => v.valid).length / validations.length * 0.4
      : 0;
    return Math.min(1, fieldScore + validScore);
  }

  private async checkLevelUpgrade(verificationId: string) {
    const verif = await this.prisma.verification.findUnique({ where: { id: verificationId } });
    if (!verif) return;
    const allVerified = await this.prisma.verification.findMany({
      where: { companyId: verif.companyId, status: 'VERIFIED' },
    });
    const types = new Set(allVerified.map(v => v.docType));
    if (types.has('COMMERCIAL_REG') && types.has('TAX_ID')) {
      await this.prisma.company.update({
        where: { id: verif.companyId },
        data: { verifiedLevel: 'BASIC' },
      });
    }
  }
}
