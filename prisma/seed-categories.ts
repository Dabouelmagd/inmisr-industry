// ─── prisma/seed-categories.ts ────────────────────────────────────
// One-time seed: populates the `categories` table with the platform's
// 46 industrial sectors (7 national-priority + 39 others), each with a
// detailed rfqTemplateJson (manufacturing stages + required inputs).
//
// 32 of the 46 sectors' rfqTemplateJson content comes directly from the
// site's existing SUPPLY_CHAINS data (real content already authored for
// the platform). The other 14 (marked "contentSource":
// "authored_by_claude" inside their rfqTemplateJson) were newly written
// for this seed and have NOT been reviewed by the team — worth a
// look before relying on them for anything customer-facing.
//
// Safe to re-run: uses upsert on the unique sectorCode, so running this
// again just updates existing rows instead of duplicating them.
//
// Run with:
//   npx ts-node prisma/seed-categories.ts
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface SeedSector {
  sectorCode: string;
  nameAr: string;
  nameEn: string;
  iconEmoji: string;
  isPriority: boolean;
  rfqTemplateJson: Record<string, unknown>;
}

async function main() {
  const dataPath = path.join(__dirname, 'seed-categories-data.json');
  const sectors: SeedSector[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  console.log(`Seeding ${sectors.length} categories...`);

  let created = 0;
  let updated = 0;

  for (const s of sectors) {
    const existing = await prisma.category.findUnique({ where: { sectorCode: s.sectorCode } });

    await prisma.category.upsert({
      where: { sectorCode: s.sectorCode },
      create: {
        sectorCode: s.sectorCode,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        iconEmoji: s.iconEmoji,
        rfqTemplateJson: s.rfqTemplateJson as any,
        isActive: true,
      },
      update: {
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        iconEmoji: s.iconEmoji,
        rfqTemplateJson: s.rfqTemplateJson as any,
      },
    });

    if (existing) updated++; else created++;
  }

  console.log(`Done. Created: ${created}, Updated: ${updated}, Total: ${sectors.length}`);

  const priorityCount = sectors.filter(s => s.isPriority).length;
  console.log(`(${priorityCount} marked as national-priority sectors — matches the frontend's PRIORITY_SECTORS list by name, no DB column needed for that flag.)`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
