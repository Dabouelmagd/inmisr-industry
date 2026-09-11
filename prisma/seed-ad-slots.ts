// ─── prisma/seed-ad-slots.ts ───────────────────────────────────────
// One-time seed: the 5 fixed ad placements from the product spec, with
// base weekly pricing (EGP). Monthly = 4 weeks at 15% off; Quarterly =
// 12 weeks at 30% off + top-of-sector pinning — calculated at booking
// time by AdsV2Service.calculatePrice(), not stored per-slot.
//
// Pricing tiers (per the spec's 3-tier structure):
//   Gold (Hero Spotlight, Top Ticker, Exit-Intent Modal) — highest
//     impressions / most exclusive placements.
//   Targeted (Sponsored Supplier Card) — sector-specific booking.
//   Standard (Section Divider Banner) — economy tier for SMEs.
//
// Safe to re-run: upserts on the unique locationKey.
//
// Run with:
//   npx ts-node prisma/seed-ad-slots.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SLOTS = [
  {
    name: 'شريط الإعلانات الترويجي العلوي',
    locationKey: 'TOP_TICKER' as const,
    dimensions: 'Desktop 1200x50 / Mobile 360x50',
    basePriceWeekly: 12000,
    maxConcurrentAds: 1,
  },
  {
    name: 'البانر الرئيسي في واجهة الهيرو',
    locationKey: 'HERO_SPOTLIGHT' as const,
    dimensions: '728x90 أو 970x250 (Billboard)',
    basePriceWeekly: 15000,
    maxConcurrentAds: 1,
  },
  {
    name: 'البطاقة المميّزة ضمن قائمة الموردين',
    locationKey: 'SPONSORED_SUPPLIER_CARD' as const,
    dimensions: 'Native B2B Card',
    basePriceWeekly: 6000,
    maxConcurrentAds: 3,
  },
  {
    name: 'بانر الفواصل بين الأقسام',
    locationKey: 'SECTION_DIVIDER' as const,
    dimensions: 'Responsive — حتى 1140x120',
    basePriceWeekly: 4000,
    maxConcurrentAds: 1,
  },
  {
    name: 'إعلان النوافذ المنبثقة الحصري',
    locationKey: 'EXIT_INTENT_MODAL' as const,
    dimensions: 'Modal — مرة واحدة لكل جلسة',
    basePriceWeekly: 10000,
    maxConcurrentAds: 1,
  },
];

async function main() {
  console.log(`Seeding ${SLOTS.length} ad slots...`);
  for (const s of SLOTS) {
    await prisma.adSlot.upsert({
      where: { locationKey: s.locationKey },
      create: s,
      update: {
        name: s.name, dimensions: s.dimensions,
        basePriceWeekly: s.basePriceWeekly, maxConcurrentAds: s.maxConcurrentAds,
      },
    });
    console.log(`  done: ${s.name} - ${s.basePriceWeekly} EGP/week`);
  }
  console.log('Done.');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
