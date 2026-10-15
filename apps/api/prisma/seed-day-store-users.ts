import bcrypt from "bcryptjs";
import { RoleName } from "@prisma/client";
import { prisma } from "../src/common/lib/prisma";

/**
 * One login per Day Store: a STORE user assigned to that store only, so it works like a Warehouse for
 * its own store (see GET /api/inventory/my-store). Safe to run again - it only creates what is missing.
 *
 *   npx tsx prisma/seed-day-store-users.ts
 *
 * Email: daystore<N>@fls.local, taken from the store's name ("Day Store 22" -> daystore22@fls.local).
 * Password: SEED_DEMO_PASSWORD, or the demo default - change it for a real rollout.
 */
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Demo1234!";

async function main() {
  const storeRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.STORE } });
  const admin = await prisma.user.findFirst({ where: { roles: { some: { role: { name: RoleName.ADMIN } } } }, select: { id: true } });
  const dayStores = await prisma.dayStore.findMany({ orderBy: { name: "asc" } });

  for (const store of dayStores) {
    const slug = store.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const email = `${slug}@fls.local`;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(PASSWORD, 12), fullName: `${store.name} (Day Store login)` } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: storeRole.id } });
      console.log(`Created ${email} / ${PASSWORD}`);
    }
    await prisma.dayStoreAssignment.upsert({
      where: { userId_dayStoreId: { userId: user.id, dayStoreId: store.id } },
      create: { userId: user.id, dayStoreId: store.id, assignedById: admin?.id ?? null },
      update: {},
    });
    console.log(`${email} -> ${store.name}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
