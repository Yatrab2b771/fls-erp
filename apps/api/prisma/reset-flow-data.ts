import { prisma } from "../src/common/lib/prisma";

/**
 * Wipes the order-to-dispatch flow data so the system can be filled again from a clean start. KEEPS the master data:
 * users and roles, Plants, Day Stores, Warehouses, product categories, Vendors, Customers, the item catalog, SKUs / BOMs and Recipes,
 * the opening stock (receipts and Day Store issues that do not belong to a PO), and BD's own address book: visiting cards and leads (with their
 * meetings). Those are the salesmen's work, not flow data, so a flow reset never touches them.
 *
 * Removes: every Purchase Order and what hangs off it (plans, Regulatory hand-off, Production runs and batches, QC, finished goods,
 * Dispatch, material requests, Vendor POs, pre-inventory), the stock movements those created, sample requests,
 * notifications, the audit log, and everything named "DEMO ..." (customers, items, SKUs, recipes).
 *
 *   npx tsx prisma/reset-flow-data.ts --yes
 */
async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This deletes all purchase orders and everything created from them. Run again with --yes to do it.");
    return;
  }
  const out: [string, number][] = [];
  const run = async (label: string, job: Promise<{ count: number }>) => out.push([label, (await job).count]);

  await prisma.$transaction(
    async (tx) => {
      const demoItems = { name: { startsWith: "DEMO" } };
      const demoCustomers = { companyName: { startsWith: "DEMO" } };

      // Production side, from the end of the line backwards
      await run("fg shipments", tx.fgShipment.deleteMany());
      await run("batch recycle logs", tx.batchRecycleLog.deleteMany());
      await run("batch COA results", tx.batchCoaTestResult.deleteMany());
      await run("combined-lot checklist", tx.combinedLotChecklistItem.deleteMany());
      await run("combined-lot events", tx.combinedLotStageEvent.deleteMany());
      await run("combined lots", tx.combinedLot.deleteMany());
      await run("production batches", tx.productionBatch.deleteMany()); // (their dispensing lines go with them)
      await run("batch number counters", tx.batchNoCounter.deleteMany());
      await run("batch consumptions", tx.batchMaterialConsumption.deleteMany());
      await run("run checklist", tx.preProductionChecklistItem.deleteMany());
      await run("run events", tx.preProductionStageEvent.deleteMany());
      await run("QC sample transactions", tx.qcSampleTransaction.deleteMany());
      await run("QC sample transfers", tx.qcSampleTransfer.deleteMany());

      // Stock movements that belong to the flow (a run, a request, a transfer, a Vendor PO, a PO) or to DEMO items; opening stock stays
      // Lot records and rejected-stock entries point at the deliveries and issues deleted below; stock corrections on DEMO items go with them.
      await run("lot allocations", tx.lotAllocation.deleteMany());
      await run("rejected-stock entries", tx.rejectedDisposition.deleteMany());
      await run("DEMO stock corrections", tx.stockAdjustment.deleteMany({ where: { item: demoItems } }));
      await run("debit notes", tx.debitNote.deleteMany());
      await run(
        "stock movements",
        tx.inventoryTransaction.deleteMany({
          where: {
            OR: [
              { preProductionId: { not: null } },
              { fulfillsRequestId: { not: null } },
              { stockTransferId: { not: null } },
              { vendorPurchaseOrderItemId: { not: null } },
              { type: { in: ["ISSUED_PRODUCTION", "ISSUED_RND"] } },
              { type: "RECEIVED", receiptStatus: { not: "ACCEPTED" } },
              { item: demoItems },
            ],
          },
        }),
      );
      await run("material requests", tx.inventoryRequest.deleteMany());
      await run("stock transfers", tx.stockTransfer.deleteMany());
      await run("vendor PO lines", tx.vendorPurchaseOrderItem.deleteMany());
      await run("vendor POs", tx.vendorPurchaseOrder.deleteMany());
      await run("finance payments", tx.financePayment.deleteMany());
  await run("finance decisions", tx.financeDecision.deleteMany());
  await run("purchase lines", tx.requirementPurchaseLine.deleteMany());
      await run("pre-inventory", tx.preInventoryRequirement.deleteMany());
      await run("PO material needs", tx.poMaterialRequirement.deleteMany());
      await run("R&D sample requests", tx.rndSampleRequest.deleteMany());
      await run("R&D store movements", tx.rndStoreTransaction.deleteMany());
      await run("R&D transfers", tx.rndTransfer.deleteMany());
      await run("dispatch transfers", tx.dispatchTransfer.deleteMany());

      // The runs, plans and the orders themselves
      await run("production runs", tx.preProduction.deleteMany());
      await run("BOM plan items", tx.bomPlanItem.deleteMany());
      await run("BOM plans", tx.bomPlan.deleteMany());
      await run("RM plan items", tx.rmPlanItem.deleteMany());
      await run("RM plans", tx.rmPlan.deleteMany());
      await run("recipe requests", tx.recipeRequest.deleteMany());
      await run("PO documents", tx.purchaseOrderDocument.deleteMany());
      await run("PO invoices", tx.purchaseOrderInvoice.deleteMany());
      await run("approved-vendor deviations (the rules themselves are R&D master data and stay)", tx.vendorDeviation.deleteMany());
      await run("PO items", tx.purchaseOrderItem.deleteMany());
      await run("purchase orders", tx.purchaseOrder.deleteMany());

      // Everything else that is about the flow
      await run("sample requests", tx.sampleRequest.deleteMany());
      await run("notifications", tx.notification.deleteMany());
      // user.* rows (logins, password changes) are kept: who made or changed a login is not flow data
      await run("audit log", tx.auditLog.deleteMany({ where: { NOT: { action: { startsWith: "user." } } } }));

      // DEMO masters
      const demoSkus = { OR: [{ customer: demoCustomers }, { productName: { startsWith: "DEMO" } }] };
      await run("DEMO BOM versions", tx.bomVersion.deleteMany({ where: { kind: "PM", entityId: { in: (await tx.sku.findMany({ where: demoSkus, select: { id: true } })).map((s) => s.id) } } }));
      await run("DEMO SKU components", tx.skuPackagingComponent.deleteMany({ where: { OR: [{ sku: demoSkus }, { pmItem: demoItems }] } }));
      await run("DEMO SKUs", tx.sku.deleteMany({ where: demoSkus }));
      const demoRecipes = { OR: [{ customer: demoCustomers }, { name: { startsWith: "DEMO" } }] };
      await run("DEMO RM BOM versions", tx.bomVersion.deleteMany({ where: { kind: "RM", entityId: { in: (await tx.recipe.findMany({ where: demoRecipes, select: { id: true } })).map((r) => r.id) } } }));
      await run("DEMO recipe ingredients", tx.recipeIngredient.deleteMany({ where: { recipe: demoRecipes } }));
      await run("DEMO recipes", tx.recipe.deleteMany({ where: demoRecipes }));
      await run("DEMO customers", tx.customer.deleteMany({ where: demoCustomers }));
      await run("DEMO items", tx.inventoryItem.deleteMany({ where: demoItems }));
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  for (const [label, n] of out) if (n > 0) console.log(`  ${label.padEnd(26)} ${n}`);
  console.log("Done. Users, plants, day stores, vendors, customers, the item catalog, BOMs, recipes and opening stock were kept.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
