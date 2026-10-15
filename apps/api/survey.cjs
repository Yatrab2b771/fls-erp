const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const del = { deletedAt: { not: null } };
  console.log("RECYCLE BIN (soft-deleted rows still in the database)");
  for (const [n, q] of [
    ["inventoryTransaction", () => p.inventoryTransaction.count({ where: del })],
    ["dispatchTransfer", () => p.dispatchTransfer.count({ where: del })],
    ["inventoryRequest", () => p.inventoryRequest.count({ where: del })],
    ["poMaterialRequirement", () => p.poMaterialRequirement.count({ where: del })],
    ["purchaseOrderItem", () => p.purchaseOrderItem.count({ where: del })],
    ["purchaseOrderDocument", () => p.purchaseOrderDocument.count({ where: del })],
    ["bomPlanItem", () => p.bomPlanItem.count({ where: del })],
    ["rmPlanItem", () => p.rmPlanItem.count({ where: del })],
    ["preInventoryRequirement", () => p.preInventoryRequirement.count({ where: del })],
  ]) console.log(`   ${String(await q()).padStart(5)}  ${n}`);

  console.log("\nOTHER PROCESS DATA STILL PRESENT");
  for (const [n, q] of [
    ["auditLog", () => p.auditLog.count()],
    ["notification", () => p.notification.count()],
    ["rndSampleRequest", () => p.rndSampleRequest.count()],
    ["batchRecycleLog", () => p.batchRecycleLog.count()],
  ]) { try { console.log(`   ${String(await q()).padStart(5)}  ${n}`); } catch (e) { console.log(`   ----  ${n} (${e.message.split("\n")[0].slice(0,50)})`); } }

  console.log("\nKEEP (stock + master data)");
  for (const [n, q] of [
    ["inventoryItem", () => p.inventoryItem.count()],
    ["inventoryTransaction (live)", () => p.inventoryTransaction.count({ where: { deletedAt: null } })],
    ["customer", () => p.customer.count()],
    ["sku", () => p.sku.count()],
    ["recipe", () => p.recipe.count()],
    ["dayStore", () => p.dayStore.count()],
    ["plant", () => p.plant.count()],
  ]) console.log(`   ${String(await q()).padStart(5)}  ${n}`);
  await p.$disconnect();
})().catch(async (e) => { console.error(e.message); await p.$disconnect(); process.exit(1); });
