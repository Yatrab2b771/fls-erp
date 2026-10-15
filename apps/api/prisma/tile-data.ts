import { prisma } from "../src/common/lib/prisma";

/**
 * Behind-the-tile counts straight from the database: which dashboard tiles have something to show.
 *   npx tsx prisma/tile-data.ts
 * Prints one line per tile family; a 0 means that tile is empty.
 */
async function main() {
  const rows: [string, number][] = [];
  const add = async (label: string, count: Promise<number>) => rows.push([label, await count]);

  await add("Warehouse FG: requested", prisma.fgShipment.count({ where: { type: "WAREHOUSE", status: "REQUESTED", deletedAt: null } }));
  await add("Warehouse FG: accepted", prisma.fgShipment.count({ where: { type: "WAREHOUSE", status: "ACCEPTED", deletedAt: null } }));
  await add("Warehouse FG: sent", prisma.fgShipment.count({ where: { type: "WAREHOUSE", status: "SENT", deletedAt: null } }));
  await add("Warehouse FG: received (stock)", prisma.fgShipment.count({ where: { type: "WAREHOUSE", status: "RECEIVED", deletedAt: null } }));
  await add("Warehouse FG: refused", prisma.fgShipment.count({ where: { type: "WAREHOUSE", status: "REJECTED", deletedAt: null } }));
  for (const status of ["REQUESTED", "SENT", "RECEIVED", "REJECTED"] as const) await add(`FG stock requests (Dispatch from Warehouse): ${status}`, prisma.fgShipment.count({ where: { type: "FROM_WAREHOUSE", status, deletedAt: null } }));
  for (const status of ["WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK", "DISPATCHED"] as const) await add(`Customer shipments: ${status}`, prisma.fgShipment.count({ where: { type: "CUSTOMER", status, deletedAt: null } }));
  for (const status of ["PAID_PARTIAL", "PAID_FULL", "ON_HOLD", "REJECTED"] as const) await add(`Finance: ${status}`, prisma.financeDecision.count({ where: { status } }));
  await add("Finance: pending (a PI line with no decision)", prisma.requirementPurchaseLine.count({ where: { status: "OPEN", finance: null } }));
  await add("Customer shipments", prisma.fgShipment.count({ where: { type: "CUSTOMER", deletedAt: null } }));
  await add("Warehouse: plan requests open (Day Store asked)", prisma.inventoryRequest.count({ where: { purpose: "ISSUED_DAY_STORE", requestingDayStoreId: { not: null }, forRequestId: { not: null }, deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } } }));
  await add("Warehouse: material requests open (Day Store)", prisma.inventoryRequest.count({ where: { purpose: "ISSUED_DAY_STORE", requestingDayStoreId: { not: null }, forRequestId: null, deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } } }));
  await add("Extra material: open", prisma.inventoryRequest.count({ where: { isExtra: true, deletedAt: null, status: { in: ["PENDING", "APPROVED"] } } }));
  await add("Extra material: issued", prisma.inventoryRequest.count({ where: { isExtra: true, deletedAt: null, status: { notIn: ["PENDING", "APPROVED", "REJECTED"] } } }));
  for (const purpose of ["PRODUCTION", "WASTE", "REJECTED", "SAMPLE"] as const) await add(`Plant consumption: ${purpose}`, prisma.batchMaterialConsumption.count({ where: { purpose } }));
  await add("R&D sample requests: pending", prisma.rndSampleRequest.count({ where: { status: "PENDING" } }));
  await add("R&D sample requests: fulfilled", prisma.rndSampleRequest.count({ where: { status: "FULFILLED" } }));
  await add("R&D transfers to R&D (unconfirmed)", prisma.rndTransfer.count({ where: { direction: "TO_RND", confirmedAt: null } }));
  await add("R&D transfers to R&D (confirmed)", prisma.rndTransfer.count({ where: { direction: "TO_RND", confirmedAt: { not: null } } }));
  await add("R&D returns (unconfirmed)", prisma.rndTransfer.count({ where: { direction: "TO_WAREHOUSE", confirmedAt: null } }));
  await add("R&D returns (confirmed)", prisma.rndTransfer.count({ where: { direction: "TO_WAREHOUSE", confirmedAt: { not: null } } }));
  for (const type of ["INBOUND", "CONSUMED", "DISPATCHED", "RETURNED"] as const) await add(`R&D store: ${type}`, prisma.rndStoreTransaction.count({ where: { type } }));
  await add("R&D direct purchases", prisma.rndStoreTransaction.count({ where: { type: "INBOUND", vendorName: { not: null } } }));
  for (const status of ["REQUESTED", "PLANNING", "IN_PROCESS", "READY", "DISPATCHED", "ON_HOLD", "CANNOT_MAKE"] as const) await add(`Customer sample requests: ${status}`, prisma.sampleRequest.count({ where: { status } }));
  for (const receiptStatus of ["PENDING_QC", "TESTING", "ON_HOLD", "QC_APPROVED", "QC_REJECTED", "ACCEPTED"] as const) await add(`Inward QC: ${receiptStatus}`, prisma.inventoryTransaction.count({ where: { type: "RECEIVED", receiptStatus, deletedAt: null } }));
  for (const regulatoryStatus of ["Approved", "Not Approved"]) await add(`Regulatory: ${regulatoryStatus}`, prisma.purchaseOrderItem.count({ where: { regulatoryStatus, deletedAt: null } }));
  await add("Regulatory: pending review", prisma.purchaseOrderItem.count({ where: { regulatoryStatus: null, sentToRegulatoryAt: { not: null }, deletedAt: null } }));
  await add("POs past promised delivery (not completed)", prisma.purchaseOrder.count({ where: { status: "APPROVED", expectedDeliveryDate: { lt: new Date() } } }));
  await add("QA gate batches on Hold", prisma.productionBatch.count({ where: { OR: [{ mfgQaStatus: "Hold" }, { packQaStatus: "Hold" }, { fgQaStatus: "Hold" }] } }));
  await add("Runs with a plan date in the past", prisma.preProduction.count({ where: { productionPlanDate: { lt: new Date() } } }));

  for (const [label, n] of rows) console.log(`${n === 0 ? "EMPTY" : "     "} ${label.padEnd(48)} ${String(n).padStart(4)}`);
  console.log(`\n${rows.filter(([, n]) => n === 0).length} empty of ${rows.length}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
