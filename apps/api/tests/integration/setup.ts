// Runs once before any integration test file is imported. Loads .env.test
// with override so the plain `dotenv/config` a static `import "./env"`
// would trigger can't accidentally point tests at the dev database.
//
// IMPORTANT: everything that transitively imports env.ts (prisma.ts,
// app.ts, ...) MUST be loaded via dynamic import() inside a function
// below, not a static top-level import — static imports are hoisted
// above this file's own dotenv.config() call regardless of source order.
import path from "node:path";
import dotenv from "dotenv";
import { afterAll, beforeAll, beforeEach } from "vitest";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test"), override: true });

if (!/fls_erp_v2_test/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(`Refusing to run integration tests — DATABASE_URL does not look like the test database: ${process.env.DATABASE_URL}`);
}

type PrismaModule = typeof import("../../src/common/lib/prisma");
type PrismaClientModule = typeof import("@prisma/client");

let prisma: PrismaModule["prisma"];
let RoleName: PrismaClientModule["RoleName"];

async function init() {
  if (prisma) return;
  ({ prisma } = await import("../../src/common/lib/prisma"));
  ({ RoleName } = await import("@prisma/client"));
}

async function assertConnectedToTestDatabase() {
  const [{ current_database: name }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (name !== "fls_erp_v2_test") {
    throw new Error(`Refusing to touch this data — the live DB connection is to "${name}", not "fls_erp_v2_test". Aborting before any truncation.`);
  }
}

beforeAll(async () => {
  await init();
  await assertConnectedToTestDatabase();
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  }
});

beforeEach(async () => {
  await init();
  await assertConnectedToTestDatabase();
  await prisma.$transaction([
    prisma.dispatchTransfer.deleteMany(),
    prisma.inventoryTransaction.deleteMany(),
    prisma.inventoryItem.deleteMany(),
    prisma.batchStageEvent.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.purchaseOrderDocument.deleteMany(),
    prisma.purchaseOrderItem.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.bomPlanItem.deleteMany(),
    prisma.bomPlan.deleteMany(),
    prisma.sku.deleteMany(),
    prisma.brand.deleteMany(),
    prisma.rmPlanItem.deleteMany(),
    prisma.rmPlan.deleteMany(),
    prisma.recipeIngredient.deleteMany(),
    prisma.recipe.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.user.deleteMany(),
  ]);
});

afterAll(async () => {
  await init();
  await prisma.$disconnect();
});
