# إن مصر للصناعة — inmisr.net
## B2B Industrial Marketplace | داتا لايف لخدمات الذكاء الصناعي

---

## 🚀 Deploy في 10 دقائق

```bash
# 1. ارفعي الملفات للسيرفر
scp -r inmisr-complete/ ubuntu@YOUR_SERVER_IP:/var/www/inmisr

# 2. SSH للسيرفر
ssh ubuntu@YOUR_SERVER_IP

# 3. حررى .env
nano /var/www/inmisr/.env.production
cp /var/www/inmisr/.env.production /var/www/inmisr/.env

# 4. شغلي سكريبت الإعداد
cd /var/www/inmisr
chmod +x scripts/setup-server.sh
sudo ./scripts/setup-server.sh
```

---

## 📁 هيكل المشروع

```
inmisr-complete/
├── src/
│   ├── auth/          # JWT + 2FA + Password Reset
│   ├── rfq/           # نظام طلبات عروض الأسعار (28 قطاع)
│   ├── escrow/        # Escrow + Paymob Webhooks
│   ├── suppliers/     # الموردون + لوحة التحكم
│   ├── products/      # المنتجات والمخزون
│   ├── finance/       # المدفوعات + الفواتير الإلكترونية
│   ├── notifications/ # FCM + Email + SMS
│   ├── geo/           # الخريطة الصناعية
│   ├── search/        # Elasticsearch عربي/إنجليزي
│   ├── admin/         # لوحة الإدارة
│   ├── loyalty/       # برنامج الولاء
│   ├── ads/           # الإعلانات الممولة
│   ├── ai/            # توقعات الأسعار
│   ├── common/        # Utilities مشتركة
│   └── app/           # App Module + Controllers
├── prisma/
│   ├── schema.prisma  # 25 جدول
│   └── seed.ts        # بيانات أولية
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── nginx.conf
├── mobile/            # React Native App
├── scripts/
│   └── setup-server.sh  ← ابدأي هنا
├── .env.production    # عبّئي هذا أولاً
└── k8s/               # Kubernetes (للمستقبل)
```

---

## ⚙️ المتطلبات

| الخدمة | الإصدار |
|--------|---------|
| Node.js | 20+ |
| PostgreSQL | 16 |
| Redis | 7 |
| RabbitMQ | 3.12 |
| Elasticsearch | 8 |

كلهم بيشتغلوا تلقائياً عبر `docker compose up -d`

---

## 🔑 المتغيرات المطلوبة في .env

```env
# Database
DATABASE_URL=postgresql://...
REDIS_URL=redis://...

# Auth
JWT_ACCESS_SECRET=   ← openssl rand -hex 64
JWT_REFRESH_SECRET=  ← openssl rand -hex 64

# Paymob
PAYMOB_API_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_IFRAME_ID=
PAYMOB_HMAC_SECRET=

# AWS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=inmisr-industry-files

# Firebase
FCM_SERVER_KEY=

# ETA (فاتورة إلكترونية)
ETA_CLIENT_ID=
ETA_CLIENT_SECRET=
ETA_SUPPLIER_TIN=
```

---

## 📊 الـ API

بعد التشغيل:
- Health Check: `GET https://api.inmisr.net/api/v1/health`
- API Docs: `GET https://api.inmisr.net/api/docs`
- Logs: `pm2 logs inmisr-api`

---

## 📱 Mobile App

```bash
cd mobile
npm install
npx expo start
```

---

*إن مصر للصناعة | الإصدار 1.0 | 2025*
