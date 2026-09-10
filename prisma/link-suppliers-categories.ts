// ─── prisma/link-suppliers-categories.ts ──────────────────────────
// One-time script: links the platform's real (non-mock) suppliers to
// their matching category via the CompanyCategory join table. Without
// this, GET /api/v1/suppliers?sector=... always returns zero results
// even though both suppliers and categories now exist for real — the
// suppliers page's sector filter needs this link to actually narrow
// anything.
//
// The mapping below was built by matching each supplier's real company
// name to the closest of the 46 seeded sectors (see
// seed-categories-data.json for the full sector list/sectorCodes).
// Worth a quick sanity check against your own knowledge of these
// accounts before relying on it for anything customer-facing.
//
// Safe to re-run: only creates a link if one doesn't already exist for
// that company (checked via findFirst before create).
//
// Run with:
//   npx ts-node prisma/link-suppliers-categories.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// companyNameAr (must match exactly what's in the DB) -> sectorCode
const SUPPLIER_SECTOR_MAP: Record<string, string> = {
  'حديد مصر للتجارة': 'iron-steel',
  'طاقة مصر الشمسية': 'solar-components',
  'الشركة المصرية للألومنيوم': 'aluminum',
  'مصانع النصر للبتروكيماويات': 'petrochemicals',
  'مصانع الدلتا للنسيج': 'textiles',
  'مصر للكيماويات الصناعية': 'specialty-chemicals',
  'مصنع الوادي للصناعات الغذائية': 'food',
  'النيل لمعدات الري': 'water-saving',
};

async function main() {
  let linked = 0;
  let skipped = 0;
  let notFound = 0;

  for (const [nameAr, sectorCode] of Object.entries(SUPPLIER_SECTOR_MAP)) {
    const company = await prisma.company.findFirst({ where: { nameAr, type: 'SUPPLIER' } });
    if (!company) {
      console.log(`⚠️  Supplier not found in DB, skipping: ${nameAr}`);
      notFound++;
      continue;
    }

    const category = await prisma.category.findUnique({ where: { sectorCode } });
    if (!category) {
      console.log(`⚠️  Category not found (did you run seed-categories.ts first?): ${sectorCode}`);
      notFound++;
      continue;
    }

    const existing = await prisma.companyCategory.findFirst({
      where: { companyId: company.id, categoryId: category.id },
    });
    if (existing) {
      console.log(`— Already linked: ${nameAr} -> ${sectorCode}`);
      skipped++;
      continue;
    }

    await prisma.companyCategory.create({
      data: { companyId: company.id, categoryId: category.id },
    });
    console.log(`✅ Linked: ${nameAr} -> ${sectorCode} (${category.nameAr})`);
    linked++;
  }

  console.log(`\nDone. Linked: ${linked}, Already linked: ${skipped}, Not found: ${notFound}`);
}

main()
  .catch((e) => {
    console.error('Linking failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
