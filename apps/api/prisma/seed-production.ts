import bcrypt from "bcryptjs";
import { RoleName } from "@prisma/client";
import { prisma } from "../src/common/lib/prisma";

/**
 * Bootstrap for a LIVE database: only what the app cannot start without. No demo users, customers, POs or stock (prisma/seed.ts is the demo seed).
 *
 *   - every role,
 *   - the two fixed Warehouse rows (RM and PM),
 *   - ONE System Admin, whose email and password you give (there is no default: a live system never ships with a known password).
 *
 * Everything else (departments' users, Plants, Stores, vendors, customers, items, BOMs) is created in the app or imported by the admin.
 * Safe to run again: it never changes an admin that already exists.
 *
 * The admin comes from LIVE_ADMIN_EMAIL / LIVE_ADMIN_PASSWORD (not the SEED_ADMIN_* of the dev .env, so a dev default can never end up in a live DB), and
 * DATABASE_URL must point at the live database; a dev or test database is refused.
 *
 *   DATABASE_URL='postgresql://user:pass@host:5432/fls_erp_live?schema=public' LIVE_ADMIN_EMAIL=you@company.com LIVE_ADMIN_PASSWORD='a long password' npx tsx prisma/seed-production.ts
 */
async function main() {
  const dbName = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
  if (/(_dev|_test)$/i.test(dbName)) throw new Error(`DATABASE_URL points at "${dbName}", a dev or test database. Point it at the live database.`);
  console.log(`Target database: ${dbName}`);
  const email = process.env.LIVE_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.LIVE_ADMIN_PASSWORD;
  if (!email || !email.includes("@")) throw new Error("Set LIVE_ADMIN_EMAIL to the admin's email address.");
  if (!password || password.length < 12) throw new Error("Set LIVE_ADMIN_PASSWORD (at least 12 characters).");

  for (const name of Object.values(RoleName)) await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  console.log(`Roles: ${Object.values(RoleName).length} ready.`);

  let admin = await prisma.user.findUnique({ where: { email } });
  if (admin) {
    console.log(`Admin ${email} already exists: left as it is.`);
  } else {
    admin = await prisma.user.create({
      data: { email, loginId: email.split("@")[0]!.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), fullName: "System Admin" },
    });
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
    console.log(`Created the System Admin: ${email}`);
  }

  for (const w of [{ name: "RM Warehouse", category: "RM" as const }, { name: "PM Warehouse", category: "PM" as const }]) {
    if (await prisma.warehouse.findUnique({ where: { category: w.category } })) continue;
    await prisma.warehouse.create({ data: { name: w.name, category: w.category, createdById: admin.id } });
    console.log(`Created warehouse: ${w.name}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
