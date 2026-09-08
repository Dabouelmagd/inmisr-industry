# إن مصر للصناعة — Launch Checklist & Operational Runbook
# ✅ قائمة متطلبات الإطلاق الكاملة

---

## 🔧 خطوات الدمج والتشغيل

```bash
# 1. أنشئي مجلد المشروع الموحد
mkdir inmisr-platform && cd inmisr-platform

# 2. فكّي الحزم بالترتيب
unzip inmisr-industry-backend.zip         # Package 1 — Core
unzip inmisr-industry-complete.zip        # Package 2 — Services  
unzip inmisr-industry-v3.zip              # Package 3 — Real-time
unzip inmisr-industry-v4-final.zip        # Package 4 — Final layer
unzip inmisr-industry-v5-complete.zip     # Package 5 — Guards & extras
unzip inmisr-industry-v6-final.zip        # Package 6 — Mobile & AI

# 3. نصب التبعيات
npm install

# 4. إعداد البيئة
cp .env.complete .env
# عبّئي كل القيم في .env

# 5. تشغيل البنية التحتية
make docker-up

# 6. إعداد قاعدة البيانات
make migrate
make seed

# 7. التحقق من الصحة
make health
# → { status: 'ok', ... }

# 8. تشغيل الاختبارات
make test && make test-e2e

# 9. بناء الإنتاج
make build

# 10. تشغيل الإنتاج
NODE_ENV=production npm start
```

---

## ✅ Pre-Launch Security Checklist

### الكود والتكوين
- [ ] تغيير جميع كلمات المرور في `.env` (لا تستخدم القيم الافتراضية أبداً)
- [ ] JWT_ACCESS_SECRET و JWT_REFRESH_SECRET: `openssl rand -hex 64`
- [ ] ENCRYPTION_MASTER_KEY: `openssl rand -base64 32`
- [ ] تفعيل 2FA على حساب Admin
- [ ] Row Level Security (RLS) مفعّل في PostgreSQL
- [ ] TLS 1.3 فقط في Nginx
- [ ] HSTS header مفعّل
- [ ] جميع الـ endpoints تعمل خلف JWT Guard
- [ ] Rate limiting على auth endpoints
- [ ] Paymob HMAC verification يعمل
- [ ] Anti-Leakage regex يبلوك الأرقام في الاختبار

### البنية التحتية
- [ ] AWS S3 Bucket: Private ACL (لا يوجد public access)
- [ ] RDS: Multi-AZ + automated backups كل 4 ساعات
- [ ] Redis: AUTH password مضبوطة
- [ ] Kubernetes: NetworkPolicy مفعّلة
- [ ] Cloudflare: WAF rules + DDoS protection
- [ ] SSL Certificate صالح

### قانوني (خارج الكود)
- [ ] تسجيل الشركة في وزارة التجارة
- [ ] ترخيص Paymob من البنك المركزي المصري
- [ ] عقد Escrow مع CIB أو QNB
- [ ] تسجيل في منظومة الفاتورة الإلكترونية (ETA)
- [ ] Penetration Testing من شركة أمن مستقلة
- [ ] سياسة الخصوصية + شروط الاستخدام منشورة

---

## 📊 Monitoring & Alerting

```bash
# Kibana — Log Analysis
http://localhost:5601

# pgAdmin — Database
http://localhost:5050

# RabbitMQ Management
http://localhost:15672

# API Health
curl https://api.inmisr.net/api/v1/health
```

### Alerts to configure in Datadog/CloudWatch:
```yaml
alerts:
  - name: "API Error Rate > 5%"
    threshold: 5%
    window: 5m
    notify: [ops@inmisr.net, slack:#alerts]

  - name: "Escrow Auto-Release Failure"
    type: log_pattern
    pattern: "Auto-release.*FAILED"
    notify: [cto@inmisr.net]

  - name: "Leakage Attempt Spike"
    threshold: 50/hour
    notify: [security@inmisr.net]

  - name: "DB CPU > 80%"
    threshold: 80%
    window: 10m
    notify: [ops@inmisr.net]

  - name: "API Response > 2s P99"
    threshold: 2000ms
    percentile: p99
    notify: [ops@inmisr.net]
```

---

## 🔄 Backup Strategy

```bash
# PostgreSQL — automated via RDS
# Frequency: every 4 hours
# Retention: 30 days
# Monthly restore test required

# S3 — Cross-region replication
aws s3api put-bucket-replication \
  --bucket inmisr-industry-files \
  --replication-configuration file://replication.json

# Elasticsearch — snapshot to S3 daily
PUT /_snapshot/s3_repository
{
  "type": "s3",
  "settings": { "bucket": "inmisr-es-snapshots" }
}
```

---

## 📱 Mobile App Deployment

```bash
# iOS — App Store
cd mobile
npx react-native run-ios --configuration Release
# Upload via Xcode to App Store Connect

# Android — Google Play
cd android && ./gradlew assembleRelease
# Upload APK to Google Play Console
```

---

## 🌍 Scaling Plan

| المستخدمون | الخطة |
|-----------|-------|
| 0 – 1,000 | 3 pods + db.r6g.large |
| 1K – 10K  | 6 pods + db.r6g.xlarge + Read Replica |
| 10K – 50K | 12 pods + db.r6g.2xlarge + PgBouncer |
| 50K+      | Multi-region + CDN edge + Kafka |

---

## 📋 API Summary — كل الـ Endpoints

```
Auth:          /api/v1/auth/*          (11 endpoints)
Suppliers:     /api/v1/suppliers/*     (5 endpoints)
Products:      /api/v1/products/*      (5 endpoints)
RFQ:           /api/v1/rfq/*           (5 endpoints)
Orders:        /api/v1/orders/*        (4 endpoints)
Escrow:        /api/v1/escrow/*        (3 endpoints)
Messages:      /api/v1/messages/*      (3 endpoints)
Reviews:       /api/v1/reviews/*       (2 endpoints)
Categories:    /api/v1/categories/*    (4 endpoints)
Subscriptions: /api/v1/subscriptions/* (4 endpoints)
Search:        /api/v1/search/*        (2 endpoints)
Maps:          /api/v1/maps/*          (5 endpoints)
Geo:           /api/v1/geo/*           (3 endpoints)
Finance:       /api/v1/finance/*       (4 endpoints)
Incubator:     /api/v1/incubator/*     (4 endpoints)
Upload:        /api/v1/upload/*        (4 endpoints)
Notifications: /api/v1/notifications/* (3 endpoints)
Loyalty:       /api/v1/loyalty/*       (4 endpoints)
Invoices:      /api/v1/invoices/*      (2 endpoints)
2FA:           /api/v1/auth/2fa/*      (5 endpoints)
Admin:         /api/v1/admin/*         (8 endpoints)
Anti-Leakage:  /api/v1/admin/al/*      (2 endpoints)
Ads:           /api/v1/ads/*           (7 endpoints)
AI Forecast:   /api/v1/ai/*            (2 endpoints)
Webhooks:      /webhooks/*             (2 endpoints)
Health:        /api/v1/health          (1 endpoint)

TOTAL: 107 API Endpoints
```

---

## 💰 تكلفة التشغيل الإجمالية

| الخدمة | USD/شهر |
|--------|---------|
| AWS EKS + EC2 | $300 |
| AWS RDS PostgreSQL | $150 |
| AWS ElastiCache | $80 |
| AWS S3 + CloudFront | $35 |
| Elasticsearch | $60 |
| Twilio SMS | $80 |
| SiteGround Email (SMTP) | $0 (included in hosting) |
| Google Maps API | $50 |
| Cloudflare Pro | $25 |
| Firebase (Push) | $0 (free tier) |
| **الإجمالي** | **~$800/شهر** |

**نقطة التعادل:** صفقة واحدة بـ ٣٢,٠٠٠ ج.م (بعمولة ٢.٥٪) تغطي التكاليف الشهرية.

---

Built with ❤️ for Egypt's Industrial Future
إن مصر للصناعة © 2025 — جميع الحقوق محفوظة
www.inmisr.net
