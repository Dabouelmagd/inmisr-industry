# 🚀 دليل الإطلاق الكامل — إن مصر للصناعة
# inmisr.net | داتا لايف لخدمات الذكاء الصناعي

---

## الخطوة ١ — Paymob (يومان)

### سجّلي على paymob.com:
1. اذهبي لـ https://paymob.com/ar → "ابدأ الآن"
2. أدخلي بيانات شركة "داتا لايف لخدمات الذكاء الصناعي"
3. ارفعي: السجل التجاري + البطاقة الضريبية + بطاقة المفوّض
4. انتظري التفعيل (٢٤-٤٨ ساعة)

### بعد التفعيل — من Dashboard:
```
Settings → Account Info:
  API_KEY        → انسخيه في .env → PAYMOB_API_KEY

Settings → Payment Integrations → Create:
  اختاري: Card Payments (Online)
  INTEGRATION_ID → انسخيه في .env → PAYMOB_INTEGRATION_ID
  
Settings → Iframes → Create:
  اختاري الـ Integration → IFRAME_ID → PAYMOB_IFRAME_ID
  
Settings → Webhooks:
  Transaction Processed URL:
    https://api.inmisr.net/webhooks/paymob/transaction
  HMAC Key → PAYMOB_HMAC_SECRET
```

---

## الخطوة ٢ — AWS (ساعتان)

```bash
# 1. أنشئي حساب على console.aws.amazon.com

# 2. IAM User للـ API
IAM → Users → Create User:
  اسم: inmisr-api-user
  Permissions: AmazonS3FullAccess + AmazonTextractFullAccess
  Access Key → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY

# 3. S3 Bucket
S3 → Create Bucket:
  Name: inmisr-industry-files
  Region: me-south-1 (Bahrain — الأقرب لمصر)
  Block all public access: ✅ (نعم — خاص)
  Versioning: Enable
  Encryption: SSE-S3

# 4. Server (EC2) أو استخدمي VPS
EC2 → Launch Instance:
  OS: Ubuntu 22.04 LTS
  Type: t3.medium (للبداية)
  Storage: 50GB SSD
  Security Group:
    Inbound: 22 (SSH), 80 (HTTP), 443 (HTTPS)
    Outbound: All
```

---

## الخطوة ٣ — Domain Setup (30 دقيقة)

```bash
# inmisr.net عندك بالفعل — اضبطي DNS Records:
# من لوحة تحكم السجل (Namecheap/GoDaddy/etc.)

Type   Name    Value
A      @       IP_ADDRESS_OF_SERVER
A      www     IP_ADDRESS_OF_SERVER
A      api     IP_ADDRESS_OF_SERVER
A      app     IP_ADDRESS_OF_SERVER
MX     @       mail.inmisr.net (SiteGround mail server)
TXT    @       "v=spf1 include:_spf.siteground.net ~all"

# SSL Certificate — على السيرفر:
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d inmisr.net -d www.inmisr.net -d api.inmisr.net -d app.inmisr.net
```

---

## الخطوة ٤ — Firebase (30 دقيقة)

```bash
# 1. console.firebase.google.com → Create Project
#    Project Name: inmisr-industry

# 2. Project Settings → Cloud Messaging:
#    Server Key → FCM_SERVER_KEY في .env

# 3. Project Settings → General:
#    Project ID → FCM_PROJECT_ID=inmisr-industry

# 4. Add App:
#    Android: com.inmisr.industry
#    iOS:     com.inmisr.industry
#    Web:     inmisr.net
```

---

## الخطوة ٥ — Google Maps (15 دقيقة)

```bash
# console.cloud.google.com
# 1. New Project: inmisr-industry
# 2. Enable APIs:
#    - Maps JavaScript API
#    - Geocoding API
#    - Directions API
#    - Places API
#    - Distance Matrix API
# 3. Credentials → Create API Key → GOOGLE_MAPS_KEY
# 4. API Key Restrictions:
#    - HTTP Referrers: *.inmisr.net/*
```

---

## الخطوة ٦ — ETA (عندك بالفعل)

```bash
# من بوابة الفاتورة الإلكترونية:
# eta.gov.eg → My Account → API Credentials

ETA_CLIENT_ID     = الـ Client ID الخاص بداتا لايف
ETA_CLIENT_SECRET = الـ Client Secret
ETA_SUPPLIER_TIN  = الرقم الضريبي للشركة
ETA_SIGNING_KEY   = مفتاح التوقيع
```

---

## الخطوة ٧ — Deploy على السيرفر

```bash
# ١. اتصلي بالسيرفر
ssh ubuntu@YOUR_SERVER_IP

# ٢. نصّبي المتطلبات
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose nodejs npm git

# ٣. Clone المشروع
git clone https://github.com/your-org/inmisr-platform.git
cd inmisr-platform

# ٤. أعدّي البيئة
cp .env.production .env
nano .env  # عبّئي كل القيم

# ٥. شغّلي البنية التحتية
cd docker && docker compose up -d postgres redis rabbitmq elasticsearch

# ٦. قاعدة البيانات
cd ..
npx prisma migrate deploy
npm run prisma:seed         # 28 قطاع + admin
ts-node prisma/seed.demo.ts # بيانات تجريبية

# ٧. بناء وتشغيل API
npm install
npm run build
NODE_ENV=production npm start

# ٨. Nginx
sudo cp nginx.inmisr.net.conf /etc/nginx/nginx.conf
sudo certbot --nginx -d inmisr.net -d api.inmisr.net
sudo systemctl restart nginx

# ٩. اختبار
curl https://api.inmisr.net/api/v1/health
# → { "status": "ok", ... }
```

---

## الخطوة ٨ — CIB Escrow

```bash
# اتصلي بـ CIB Corporate Banking: 19666
# قولي: "محتاجة Escrow Account لمنصة B2B اسمها إن مصر للصناعة"

# الأوراق المطلوبة:
# - عقد تأسيس شركة داتا لايف
# - البطاقة الضريبية
# - السجل التجاري
# - خطاب شرح النشاط (منصة وساطة بين المصانع والموردين)

# المدة: 2-4 أسابيع

# في الانتظار: استخدمي حساب الشركة العادي في CIB مؤقتاً
# وسجّلي المعاملات يدوياً في قاعدة البيانات
```

---

## الخطوة ٩ — الإطلاق الناعم (Beta)

```bash
# أول ٢ أسبوع — Beta مغلق:
# - ادعي ١٠-٢٠ مورد تعرفيهم
# - ادعي ٥-١٠ مصانع
# - راقبي الـ logs: docker compose logs api -f
# - اجمعي الملاحظات وصلّحي الأخطاء

# مقاييس النجاح قبل الإطلاق العام:
# ✓ أول RFQ منشور
# ✓ أول عرض سعر مستلم
# ✓ أول صفقة مكتملة بـ Escrow
# ✓ لا crashes في الـ 24 ساعة الأولى
```

---

## الخطوة ١٠ — الإطلاق العام

```bash
# بعد البيتا والـ Escrow الرسمي:
# - أضيفي Google Analytics + Hotjar
# - ابدئي حملة LinkedIn Ads للمصانع والموردين
# - سجّلي في مجلة مصر الصناعية + اتحاد الصناعات
# - اطلبي تغطية من IT Business News Arabia

# الهدف الشهر الأول:
# 100 مورد مسجل ← 30 موثق ← 10 صفقات مكتملة
```

---

## ملفات تحتاجيها فوراً

| الملف | المكان |
|-------|--------|
| `.env.production` | هذا الملف — عبّئيه |
| `nginx.inmisr.net.conf` | `/etc/nginx/nginx.conf` على السيرفر |
| `docker-compose.yml` | `docker/docker-compose.yml` من Package 1 |
| `prisma/schema.prisma` | من Package 1 |

---

**الخلاصة — ترتيب الأولويات:**
1. Paymob Account (اليوم)
2. AWS Account + EC2 + S3 (اليوم)
3. DNS على inmisr.net (اليوم)
4. عبّئي .env + Deploy (غداً)
5. اتصلي بـ CIB 19666 (هذا الأسبوع)

---
داتا لايف لخدمات الذكاء الصناعي © 2025
inmisr.net — منصة التصنيع الرقمي الأولى في مصر
