#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# إن مصر للصناعة — Server Setup Script
# Ubuntu 22.04 | inmisr.net
# ═══════════════════════════════════════════════════════════════
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   إن مصر للصناعة - Server Setup          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. System Update ──────────────────────────────────────────
log "Updating system..."
apt update -qq && apt upgrade -y -qq

# ── 2. Install Dependencies ───────────────────────────────────
log "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs -qq
node -v && npm -v

log "Installing Docker..."
apt install -y docker.io docker-compose curl git unzip certbot python3-certbot-nginx -qq
systemctl enable docker && systemctl start docker

# ── 3. Firewall ───────────────────────────────────────────────
log "Configuring firewall..."
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# ── 4. Clone / Upload Project ─────────────────────────────────
log "Setting up project directory..."
mkdir -p /var/www/inmisr
# If using git:
# git clone https://github.com/YOUR_ORG/inmisr-platform.git /var/www/inmisr
# OR upload the ZIP and extract:
# unzip inmisr-complete.zip -d /var/www/inmisr

cd /var/www/inmisr

# ── 5. Environment ────────────────────────────────────────────
if [ ! -f .env ]; then
  warn ".env not found — copying .env.production"
  cp .env.production .env
  warn "IMPORTANT: Edit .env with your real credentials before continuing!"
  echo ""
  echo "  nano /var/www/inmisr/.env"
  echo ""
  read -p "Press ENTER after editing .env to continue..."
fi

# ── 6. Start Infrastructure ───────────────────────────────────
log "Starting Docker services (PostgreSQL, Redis, RabbitMQ, Elasticsearch)..."
cd docker
docker compose up -d
cd ..

log "Waiting for PostgreSQL to be ready..."
sleep 10

# ── 7. Install & Build ────────────────────────────────────────
log "Installing npm packages..."
npm install --production=false

log "Running database migrations..."
npx prisma migrate deploy

log "Seeding database (28 sectors + admin)..."
npx ts-node prisma/seed.ts

log "Building application..."
npm run build

# ── 8. Start App with PM2 ─────────────────────────────────────
log "Installing PM2..."
npm install -g pm2

log "Starting inmisr API..."
pm2 start dist/src/main.js --name "inmisr-api" --env production
pm2 save
pm2 startup

# ── 9. Nginx ──────────────────────────────────────────────────
log "Configuring Nginx..."
cp docker/nginx.conf /etc/nginx/sites-available/inmisr
ln -sf /etc/nginx/sites-available/inmisr /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# ── 10. SSL ───────────────────────────────────────────────────
log "Installing SSL certificates..."
certbot --nginx \
  -d inmisr.net \
  -d www.inmisr.net \
  -d api.inmisr.net \
  -d app.inmisr.net \
  --non-interactive --agree-tos -m support@inmisr.net

# ── 11. Health Check ──────────────────────────────────────────
log "Running health check..."
sleep 3
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/health)
if [ "$STATUS" = "200" ]; then
  log "API is healthy! ✓"
else
  warn "Health check returned $STATUS — check logs: pm2 logs inmisr-api"
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✓  إن مصر للصناعة is LIVE!                         ║"
echo "║                                                      ║"
echo "║  API:    https://api.inmisr.net                      ║"
echo "║  Web:    https://inmisr.net                          ║"
echo "║  Logs:   pm2 logs inmisr-api                         ║"
echo "║  Status: pm2 status                                  ║"
echo "╚══════════════════════════════════════════════════════╝"
