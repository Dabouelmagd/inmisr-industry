// ─── invoice/invoice.service.ts ───────────────────────────────────
// منظومة الفاتورة الإلكترونية — ETA API Integration
// مصلحة الضرائب المصرية — Egyptian Tax Authority
// قانون الفاتورة الإلكترونية رقم ٩١ لسنة ٢٠٠٥ + التعديلات ٢٠٢٠

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import axios from 'axios';
import * as crypto from 'crypto';

interface EtaInvoiceLine {
  description:   string;
  itemType:      string;   // 'GS1' | 'EGS'
  itemCode:      string;
  unitType:      string;   // 'EA' = each, 'KGM' = kilogram, 'TNE' = tonne
  quantity:      number;
  unitValue: {
    currencySold: string;  // 'EGP'
    amountEGP:    number;
    amountSold:   number;
  };
  salesTotal:    number;
  taxableItems:  { taxType: string; amount: number; subType: string; rate: number }[];
  netTotal:      number;
  total:         number;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);
  private readonly etaBaseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.etaBaseUrl = config.get('ETA_BASE_URL', 'https://api.invoicing.eta.gov.eg/api/v1');
  }

  // ── ISSUE INVOICE for a completed order ──────────────────────
  async issueInvoice(orderId: string): Promise<any> {
    const order = await this.prisma.order.findUnique({
      where:   { id: orderId },
      include: {
        buyer:    { include: { location: true } },
        supplier: { include: { location: true } },
        rfq:      { include: { category: true } },
      },
    });
    if (!order) throw new BadRequestException('الطلب غير موجود');

    const token = await this.getAccessToken();
    const internalSerial = `INV-${Date.now()}-${orderId.slice(-6).toUpperCase()}`;

    const invoicePayload = {
      documents: [{
        issuer: {
          type:    'B',
          id:      this.config.get('ETA_SUPPLIER_TIN'),   // Tax Identification Number
          name:    'إن مصر للصناعة',
          address: {
            branchID:    '0',
            country:     'EG',
            governate:   'Cairo',
            regionCity:  'New Cairo',
            street:      'التجمع الخامس',
            buildingNumber: '1',
            postalCode:  '11865',
          },
        },
        receiver: {
          type:    'B',
          id:      order.buyer.taxId || '000000000',
          name:    order.buyer.nameAr,
          address: {
            branchID:    '0',
            country:     'EG',
            governate:   order.buyer.location?.governorate || 'Cairo',
            regionCity:  order.buyer.location?.city || 'Cairo',
            street:      order.buyer.location?.addressAr || '',
            buildingNumber: '1',
            postalCode:  order.buyer.location?.postalCode || '11511',
          },
        },
        documentType:          'I',   // Invoice
        documentTypeVersion:   '1.0',
        dateTimeIssued:        new Date().toISOString(),
        taxpayerActivityCode:  '4661', // Wholesale of industrial materials
        internalID:            internalSerial,
        invoiceLines:          this.buildInvoiceLines(order),
        taxTotals: [{
          taxType: 'T1',  // VAT
          amount:  +(order.amount * 0.14).toFixed(2), // 14% VAT
        }],
        extraDiscountAmount:   0,
        totalDiscountAmount:   this.calculateDiscount(order),
        totalSalesAmount:      order.amount,
        netAmount:             order.amount - this.calculateDiscount(order),
        totalAmount:           +(order.amount * 1.14).toFixed(2),
        totalItemsDiscountAmount: 0,
      }],
    };

    // Sign the invoice
    const signed = await this.signInvoice(invoicePayload);

    // Submit to ETA
    try {
      const response = await axios.post(
        `${this.etaBaseUrl}/documentsubmissions`,
        signed,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const result = response.data;
      const etaUuid = result.submissionId || result.acceptedDocuments?.[0]?.uuid;

      // Store invoice record
      await this.prisma.auditLog.create({
        data: {
          action:   'INVOICE_ISSUED',
          entity:   'Order',
          entityId: orderId,
          newValue: {
            internalSerial,
            etaUuid,
            amount:    order.amount,
            vat:       +(order.amount * 0.14).toFixed(2),
            total:     +(order.amount * 1.14).toFixed(2),
            issuedAt:  new Date().toISOString(),
          },
        },
      });

      this.logger.log(`Invoice issued: ${internalSerial} → ETA UUID: ${etaUuid}`);
      return { internalSerial, etaUuid, total: +(order.amount * 1.14).toFixed(2) };
    } catch (err) {
      this.logger.error('ETA invoice submission failed', err.response?.data || err.message);
      // Store as pending for retry
      await this.prisma.auditLog.create({
        data: {
          action:   'INVOICE_FAILED',
          entity:   'Order',
          entityId: orderId,
          newValue: { error: err.message, internalSerial, retryCount: 0 },
        },
      });
      throw new BadRequestException(`فشل إصدار الفاتورة: ${err.message}`);
    }
  }

  // ── GET INVOICE STATUS from ETA ───────────────────────────────
  async getInvoiceStatus(etaUuid: string) {
    const token = await this.getAccessToken();
    const res = await axios.get(
      `${this.etaBaseUrl}/documents/${etaUuid}/details`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return res.data;
  }

  // ── BUILD INVOICE LINES from order data ───────────────────────
  private buildInvoiceLines(order: any): EtaInvoiceLine[] {
    const unitType = this.mapUnit(order.rfq?.unit || 'unit');
    const vatAmount = +(order.amount * 0.14).toFixed(2);

    return [{
      description: `${order.rfq?.category?.nameAr || 'خامات صناعية'} — ${order.rfq?.quantity || 0} ${order.rfq?.unit || ''}`,
      itemType:    'GS1',
      itemCode:    order.rfq?.categoryId?.slice(-8) || '00000000',
      unitType,
      quantity:    order.rfq?.quantity || 1,
      unitValue: {
        currencySold: 'EGP',
        amountEGP:    order.amount,
        amountSold:   order.amount,
      },
      salesTotal: order.amount,
      taxableItems: [{
        taxType:   'T1',   // VAT
        amount:    vatAmount,
        subType:   'V009', // Standard rate
        rate:      14,
      }],
      netTotal: order.amount,
      total:    +(order.amount + vatAmount).toFixed(2),
    }];
  }

  // ── SIGN INVOICE with private key ─────────────────────────────
  private async signInvoice(payload: any): Promise<any> {
    // In production: use ITIDA-certified USB token or HSM
    // For now: HMAC-SHA256 signature
    const serialized = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', this.config.get('ETA_SIGNING_KEY', 'dev-key'))
      .update(serialized)
      .digest('hex');

    return {
      ...payload,
      signatures: [{
        signatureType: 'I',
        value:         signature,
      }],
    };
  }

  // ── GET ETA ACCESS TOKEN ──────────────────────────────────────
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }
    const res = await axios.post(
      `${this.etaBaseUrl}/connect/token`,
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.config.get('ETA_CLIENT_ID', ''),
        client_secret: this.config.get('ETA_CLIENT_SECRET', ''),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    this.accessToken   = res.data.access_token;
    this.tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
    return this.accessToken!;
  }

  private mapUnit(unit: string): string {
    const map: Record<string, string> = {
      'طن': 'TNE', 'كجم': 'KGM', 'جرام': 'GRM',
      'لتر': 'LTR', 'متر': 'MTR', 'وحدة': 'EA', 'لوح': 'EA',
    };
    return map[unit] || 'EA';
  }

  private calculateDiscount(order: any): number {
    // Recurring order discounts
    return 0; // Applied at order level
  }

  // ── RETRY FAILED INVOICES (Cron) ─────────────────────────────
  async retryFailedInvoices() {
    const failed = await this.prisma.auditLog.findMany({
      where: {
        action: 'INVOICE_FAILED',
        newValue: { path: ['retryCount'], lte: 3 },
        createdAt: { gte: new Date(Date.now() - 48 * 3600000) },
      },
      take: 20,
    });

    for (const log of failed) {
      const data = log.newValue as any;
      try {
        await this.issueInvoice(log.entityId!);
        this.logger.log(`Retry invoice success: ${log.entityId}`);
      } catch {
        await this.prisma.auditLog.update({
          where: { id: log.id },
          data:  { newValue: { ...data, retryCount: (data.retryCount || 0) + 1 } },
        });
      }
    }
  }
}
