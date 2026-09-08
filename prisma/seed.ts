// ─── prisma/seed.complete.ts ──────────────────────────────────────
import { PrismaClient, Role, VerifiedLevel, SubscriptionPlan } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SECTORS = [
  { ar: 'الحديد ومشتقاته',            en: 'Iron & Steel',                    code: 'iron_steel',     emoji: '🔩' },
  { ar: 'البتروكيماويات',              en: 'Petrochemicals',                  code: 'petrochemicals', emoji: '🛢️' },
  { ar: 'مكونات الطاقة الشمسية',       en: 'Solar Energy Components',         code: 'solar',          emoji: '☀️' },
  { ar: 'سيارات ومكوناتها',            en: 'Automotive Components',           code: 'automotive',     emoji: '🚗' },
  { ar: 'برمجيات التحكم الصناعي',      en: 'Industrial Control (SCADA)',      code: 'scada',          emoji: '🖥️' },
  { ar: 'مكونات طاقة الرياح',          en: 'Wind Energy Components',          code: 'wind',           emoji: '🌬️' },
  { ar: 'محطات التحلية (مكونات)',       en: 'Desalination Components',         code: 'desalination',   emoji: '💧' },
  { ar: 'ألبان الأطفال (تصنيع)',        en: 'Infant Formula Manufacturing',    code: 'infant_formula', emoji: '🍼' },
  { ar: 'الألومنيوم',                  en: 'Aluminium',                       code: 'aluminum',       emoji: '🔧' },
  { ar: 'المحولات الكهربائية',          en: 'Electrical Transformers',         code: 'transformers',   emoji: '⚡' },
  { ar: 'مواسير غير ملحومة',            en: 'Seamless Pipes',                  code: 'seamless_pipes', emoji: '🔩' },
  { ar: 'مضخات ومواتير',               en: 'Pumps & Motors',                  code: 'pumps_motors',   emoji: '⚙️' },
  { ar: 'مستحضرات طبية وتجميل',        en: 'Pharma & Cosmetics',              code: 'pharma',         emoji: '💊' },
  { ar: 'صناعة البوليستر',              en: 'Polyester Manufacturing',         code: 'polyester',      emoji: '🧵' },
  { ar: 'الصودا آش',                   en: 'Soda Ash',                        code: 'soda_ash',       emoji: '🧪' },
  { ar: 'المحركات الكهربائية',          en: 'Electric Motors',                 code: 'electric_motors',emoji: '⚙️' },
  { ar: 'المولدات الكهربائية',          en: 'Electric Generators',             code: 'generators',     emoji: '🔌' },
  { ar: 'الأحبار الصناعية',             en: 'Industrial Inks',                 code: 'inks',           emoji: '🖨️' },
  { ar: 'الأدوات الكهربائية',           en: 'Electrical Tools & Switches',     code: 'electrical_tools',emoji: '🔌' },
  { ar: 'مواد قابلة للتدوير',           en: 'Recyclable Materials',            code: 'recyclables',    emoji: '♻️' },
  { ar: 'تشيلرز التكييف المركزي',       en: 'Central HVAC Chillers',           code: 'chillers',       emoji: '❄️' },
  { ar: 'المصاعد والسلالم الكهربائية',  en: 'Elevators & Escalators',         code: 'elevators',      emoji: '🛗' },
  { ar: 'أنظمة المراقبة الذكية',        en: 'Smart Surveillance Systems',      code: 'surveillance',   emoji: '📹' },
  { ar: 'الروبوتات المتقدمة',           en: 'Advanced Robotics',               code: 'robotics',       emoji: '🤖' },
  { ar: 'الهيدروجين الأخضر',            en: 'Green Hydrogen',                  code: 'green_hydrogen', emoji: '🌿' },
  { ar: 'الصناعات النسيجية',            en: 'Textile Industries',              code: 'textile',        emoji: '🧶' },
  { ar: 'الصناعات الغذائية',            en: 'Food Industries',                 code: 'food',           emoji: '🌾' },
  { ar: 'الصناعات الجلدية',             en: 'Leather Industries',              code: 'leather',        emoji: '👜' },
];

const SAMPLE_COMPANIES = [
  { nameAr: 'حديد مصر للتجارة', city: 'العاشر من رمضان', lat: 30.294, lng: 31.743, sector: 'iron_steel', trust: 94 },
  { nameAr: 'البتروكيماويات الحديثة', city: '٦ أكتوبر', lat: 29.970, lng: 30.930, sector: 'petrochemicals', trust: 87 },
  { nameAr: 'طاقة مصر الشمسية', city: '٦ أكتوبر', lat: 29.975, lng: 30.935, sector: 'solar', trust: 92 },
  { nameAr: 'الألومنيوم المصري', city: 'العاشر من رمضان', lat: 30.290, lng: 31.748, sector: 'aluminum', trust: 88 },
  { nameAr: 'المحولات العربية', city: 'مدينة العبور', lat: 30.249, lng: 31.818, sector: 'transformers', trust: 79 },
];

async function main() {
  console.log('\n🌱 Seeding إن مصر للصناعة...\n' + '═'.repeat(50));

  // ── 1. Seed 28 sectors ────────────────────────────────────────
  console.log('📦 Creating 28 industrial sectors...');
  for (const s of SECTORS) {
    await prisma.category.upsert({
      where:  { sectorCode: s.code },
      update: {},
      create: {
        nameAr: s.ar, nameEn: s.en, sectorCode: s.code,
        iconEmoji: s.emoji, isActive: true,
        rfqTemplateJson: {
          generalFields: ['quantity', 'unit', 'grade', 'deadline', 'delivery_city', 'payment_method'],
          sectorFields:  ['specifications', 'certifications', 'packaging'],
        },
      },
    });
  }
  console.log(`  ✅ ${SECTORS.length} sectors created`);

  // ── 2. Super Admin ────────────────────────────────────────────
  console.log('\n👤 Creating admin...');
  const adminPw = process.env.ADMIN_INITIAL_PASSWORD || 'Admin@InMisr2025!';
  const adminHash = await bcrypt.hash(adminPw, 12);
  const admin = await prisma.user.upsert({
    where:  { email: 'admin@inmisr.net' },
    update: {},
    create: {
      email: 'admin@inmisr.net', emailVerified: true,
      passwordHash: adminHash, role: 'SUPER_ADMIN', kycStatus: 'VERIFIED',
      company: {
        create: {
          nameAr: 'إن مصر للصناعة', nameEn: 'InMisr Industry Platform',
          type: 'ADMIN', verifiedLevel: 'ELITE', trustScore: 100,
          subscription: { create: { plan: 'ELITE' } },
        },
      },
    },
  });
  console.log(`  ✅ Admin: admin@inmisr.net / ${adminPw}`);

  // ── 3. Sample suppliers ───────────────────────────────────────
  console.log('\n🏭 Creating sample suppliers...');
  for (const s of SAMPLE_COMPANIES) {
    const cat = await prisma.category.findUnique({ where: { sectorCode: s.sector } });
    if (!cat) continue;

    const email = `${s.sector}@supplier.test.inmisr.net`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) continue;

    const pw = await bcrypt.hash('Supplier@2025!', 10);
    await prisma.user.create({
      data: {
        email, emailVerified: true, passwordHash: pw,
        role: 'SUPPLIER', kycStatus: 'VERIFIED',
        company: {
          create: {
            nameAr: s.nameAr, type: 'SUPPLIER',
            verifiedLevel: 'CERTIFIED', trustScore: s.trust,
            avgRating: 4.5, totalDeals: 120,
            subscription: { create: { plan: 'GROWTH' } },
            location: { create: { city: s.city, governorate: s.city, lat: s.lat, lng: s.lng } },
            categories: { create: { categoryId: cat.id } },
            loyaltyPoints: { create: { points: 2500, tier: 'SILVER', totalEarned: 3000 } },
          },
        },
      },
    });
  }
  console.log(`  ✅ ${SAMPLE_COMPANIES.length} sample suppliers created`);

  // ── 4. Sample feasibility studies ────────────────────────────
  console.log('\n💡 Creating feasibility studies...');
  const ironCat = await prisma.category.findUnique({ where: { sectorCode: 'iron_steel' } });
  if (ironCat) {
    await prisma.feasibilityStudy.upsert({
      where: { id: 'fs-001-bolts' },
      update: {},
      create: {
        id: 'fs-001-bolts',
        title: 'مصنع براغي وصواميل صناعية',
        sectorId: ironCat.id, region: 'العاشر من رمضان',
        investmentReq: 2400000, roiEstimate: 31, paybackMonths: 22,
        demandDataJson: { monthlyDemand: 45000, unit: 'كجم', importShare: 82 },
        factoriesJson: [
          { nameAr: 'مصانع المستقبل للمعدات', monthlyNeedKg: 500 },
          { nameAr: 'النيل للإنشاءات', monthlyNeedKg: 1200 },
        ],
        fundingJson: [
          { name: 'صندوق تنمية الصناعة', maxAmount: 1500000, rate: 5 },
          { name: 'بنك التنمية الصناعية', maxAmount: 2000000, rate: 6 },
        ],
        status: 'PUBLISHED',
      },
    });
  }
  console.log('  ✅ Feasibility studies created');

  console.log('\n' + '═'.repeat(50));
  console.log('🎉 Seed complete!\n');
  console.log('  Admin:      admin@inmisr.net');
  console.log('  Password:   ' + adminPw);
  console.log('  Sectors:    ' + SECTORS.length);
  console.log('  Suppliers:  ' + SAMPLE_COMPANIES.length);
  console.log('\n  API:     http://localhost:3001/api/v1');
  console.log('  Swagger: http://localhost:3001/docs');
  console.log('═'.repeat(50) + '\n');
}

main()
  .catch(e => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
