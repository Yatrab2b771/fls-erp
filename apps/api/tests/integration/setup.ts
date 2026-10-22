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

// What the Warehouse issues to a Store is in transit until the Store receives it. Most tests are about something else (dispensing, plans, stock ...) and
// start from "the Store has it", as they always did: they would each have to confirm the arrival first. So, unless a test says otherwise, those issues arrive
// the moment they are created. A test of the receiving step itself (or of transit) switches this off for itself:
//   (globalThis as { __flsStoreReceivesAtOnce?: boolean }).__flsStoreReceivesAtOnce = false;
// It is back on at the start of every test.
type StoreReceivesFlag = { __flsStoreReceivesAtOnce?: boolean };
let hooked = false;

async function init() {
  if (prisma) return;
  ({ prisma } = await import("../../src/common/lib/prisma"));
  ({ RoleName } = await import("@prisma/client"));
  if (!hooked) {
    hooked = true;
    prisma.$use(async (params, next) => {
      if (params.model === "InventoryTransaction" && (params.action === "create" || params.action === "createMany") && (globalThis as StoreReceivesFlag).__flsStoreReceivesAtOnce !== false) {
        const data = params.args.data as Record<string, unknown> | Record<string, unknown>[];
        for (const row of Array.isArray(data) ? data : [data]) {
          if (row.type === "ISSUED_DAY_STORE" && row.isTransitTracked === true && !row.deliveredAt) {
            row.deliveredAt = new Date();
            row.deliveredById = row.createdById ?? null;
          }
        }
      }
      return next(params);
    });
  }
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
  (globalThis as StoreReceivesFlag).__flsStoreReceivesAtOnce = true;
  await init();
  await assertConnectedToTestDatabase();
  await prisma.$transaction([
    // Lot allocations, rejected-stock dispositions and stock corrections reference InventoryTransaction / InventoryItem / DayStore /
    // Plant (RESTRICT) - they go first, same reasoning as everything else in this list.
    prisma.lotAllocation.deleteMany(),
    // Approved-vendor rules reference InventoryItem (RESTRICT) and Vendor.
    prisma.vendorDeviation.deleteMany(),
    prisma.productMaterialVendor.deleteMany(),
    prisma.rejectedDisposition.deleteMany(),
    prisma.stockAdjustment.deleteMany(),
    prisma.dispatchTransfer.deleteMany(),
    // DebitNote references InventoryTransaction (transactionId) with a
    // RESTRICT FK — must go before inventoryTransaction below, same
    // reasoning as every other row in this list.
    prisma.debitNote.deleteMany(),
    prisma.inventoryTransaction.deleteMany(),
    prisma.inventoryRequest.deleteMany(),
    // Vendor POs reference InventoryItem and Vendor (RESTRICT); their receipts (inventoryTransaction) are already gone above.
    prisma.financePayment.deleteMany(),
    prisma.financeDecision.deleteMany(),
    prisma.vendorPurchaseOrderItem.deleteMany(),
    prisma.vendorPurchaseOrder.deleteMany(),
    prisma.vendor.deleteMany(),
    prisma.preInventoryRequirement.deleteMany(),
    // QcSampleTransaction references QcSampleTransfer (transferId) as well
    // as PreProduction/InventoryItem — must go before QcSampleTransfer and
    // before preProduction/inventoryItem below, same RESTRICT-FK reasoning
    // as everything else in this list.
    prisma.qcSampleTransaction.deleteMany(),
    prisma.qcSampleTransfer.deleteMany(),
    // References CombinedLot only — must go before combinedLot below.
    prisma.batchRecycleLog.deleteMany(),
    prisma.batchCoaTestResult.deleteMany(),
    prisma.combinedLotChecklistItem.deleteMany(),
    prisma.combinedLotStageEvent.deleteMany(),
    prisma.combinedLot.deleteMany(),
    // References PreProduction only — must go before preProduction below.
    prisma.productionBatch.deleteMany(),
    // Both reference PreProduction (and consumption also references
    // InventoryItem) — must go before preProduction/dayStore/plant/
    // inventoryItem below, same RESTRICT-FK reasoning as everything else
    // in this list.
    prisma.batchMaterialConsumption.deleteMany(),
    prisma.productBomVersion.deleteMany(),
    prisma.preProductionChecklistItem.deleteMany(),
    prisma.preProductionStageEvent.deleteMany(),
    prisma.preProduction.deleteMany(),
    // References both InventoryItem and PurchaseOrder — must go before
    // both are cleared below, same RESTRICT-FK reasoning.
    prisma.poMaterialRequirement.deleteMany(),
    // RndSampleRequest references RndTransfer (once fulfilled) as well as
    // InventoryItem — must go before both, same RESTRICT-FK reasoning.
    // RndStoreTransaction references InventoryItem, Customer, and
    // RndTransfer; RndTransfer references InventoryItem — both must go
    // before inventoryItem/customer below, same RESTRICT-FK reasoning.
    prisma.rndSampleRequest.deleteMany(),
    prisma.rndStoreTransaction.deleteMany(),
    prisma.rndTransfer.deleteMany(),
    // StockTransfer references InventoryItem, DayStore and Plant (RESTRICT) - must go before all three.
    prisma.stockTransfer.deleteMany(),
    prisma.dayStore.deleteMany(),
    prisma.plant.deleteMany(),
    prisma.inventoryItem.deleteMany(),
    prisma.purchaseOrderDocument.deleteMany(),
    prisma.purchaseOrderItem.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.bomPlanItem.deleteMany(),
    prisma.bomPlan.deleteMany(),
    // Sku now hangs directly off Customer (the old separate Brand model
    // is gone — see the Sku model's own schema comment), so it has to be
    // cleared before Customer, same RESTRICT-FK reasoning as everything
    // else in this list.
    prisma.sampleRequest.deleteMany(),
    prisma.lead.deleteMany(),
    prisma.businessCard.deleteMany(),
    prisma.bomVersion.deleteMany(),
    prisma.sku.deleteMany(),
    prisma.customer.deleteMany(),
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
