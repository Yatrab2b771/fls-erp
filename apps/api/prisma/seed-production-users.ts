import bcrypt from "bcryptjs";
import { RoleName } from "@prisma/client";
import { prisma } from "../src/common/lib/prisma";

/**
 * One Production login per Plant: a PRODUCTION user assigned to that Plant only, so it sees and acts on that Plant's runs,
 * batches, consumption and transfers - the Production side of the Day Store login with the same number. Safe to run
 * again: it only creates what is missing.
 *
 *   npx tsx prisma/seed-production-users.ts
 *
 * Email: production<N>@fls.local, from the Plant's name ("Day Store 22" -> production22@fls.local).
 * Password: SEED_DEMO_PASSWORD, or the demo default - change it for a real rollout. The original all-Plants
 * production@fls.local login is left as it is.
 */
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Demo1234!";

async function main() {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.PRODUCTION } });
  const admin = await prisma.user.findFirst({ where: { roles: { some: { role: { name: RoleName.ADMIN } } } }, select: { id: true } });
  const plants = await prisma.plant.findMany({ where: { dayStoreId: { not: null } }, orderBy: { name: "asc" } });

  for (const plant of plants) {
    const slug = plant.name.toLowerCase().replace(/^day\s*store\s*/, "").replace(/[^a-z0-9]+/g, "");
    const email = `production${slug}@fls.local`;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(PASSWORD, 12), fullName: `Production ${slug} (Plant login)` } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      console.log(`Created ${email} / ${PASSWORD}`);
    }
    await prisma.plantAssignment.upsert({
      where: { userId_plantId: { userId: user.id, plantId: plant.id } },
      create: { userId: user.id, plantId: plant.id, assignedById: admin?.id ?? null },
      update: {},
    });
    console.log(`${email} -> Plant ${plant.name}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
