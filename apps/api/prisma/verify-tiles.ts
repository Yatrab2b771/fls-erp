import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";
import { checkDataIntegrity, type ItemStage, type StageRow } from "../src/modules/ppic/data-integrity";

/**
 * Does every dashboard tile show EXACTLY the products that are at its stage, and nothing else?
 *
 *   npx tsx prisma/verify-tiles.ts
 *
 * Each product's one stage is worked out from its records (data-integrity.ts); each tile's list is then fetched through the real API and
 * compared with it. Prints one line per tile; exit code 1 if any tile shows a product it should not, or misses one it should.
 */
const app = createApp();

async function tokenFor(role: string): Promise<string> {
  // The department login that sees everything: not a Plant's or a Day Store's own login (those see only their own work)
  const user = await prisma.user.findFirstOrThrow({
    where: { roles: { some: { role: { name: role as never } } }, plantAssignments: { none: {} }, dayStoreAssignments: { none: {} } },
    orderBy: { email: "asc" },
    include: { roles: { include: { role: true } } },
  });
  return signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
}

async function getAll(token: string, path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await request(app).get(`${path}${sep}page=${page}&pageSize=200`).set("Authorization", `Bearer ${token}`);
    if (res.status !== 200) throw new Error(`${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    const rows = Array.isArray(res.body) ? res.body : [];
    out.push(...rows);
    const total = Number(res.headers["x-total-count"] ?? rows.length);
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

const keyOf = (po: unknown, product: unknown) => `${po}|${product}`;
const poOf = (r: any) => r.po?.poNumber ?? r.poNumber ?? r.product?.poNumber ?? r.purchaseOrder?.poNumber;
const productOf = (r: any) => r.item?.productName ?? r.productName ?? r.product?.productName;
const uniq = (xs: string[]) => [...new Set(xs)].sort();

let failures = 0;
function report(tile: string, expected: string[], actual: string[]) {
  const e = new Set(expected);
  const a = new Set(actual);
  const missing = [...e].filter((k) => !a.has(k));
  const extra = [...a].filter((k) => !e.has(k));
  const ok = missing.length === 0 && extra.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${tile.padEnd(46)} expected ${String(e.size).padStart(3)}  shows ${String(a.size).padStart(3)}`);
  for (const k of missing) console.log(`       missing: ${k}`);
  for (const k of extra) console.log(`       should not be here: ${k}`);
}

async function main() {
  const { rows } = await checkDataIntegrity();
  const at = (...stages: ItemStage[]) => rows.filter((r) => stages.includes(r.stage));
  const keys = (rs: StageRow[]) => rs.map((r) => keyOf(r.po, r.product));

  const [ppic, qa, store, dispatch, rnd] = await Promise.all([tokenFor("PPIC"), tokenFor("QA_QC"), tokenFor("STORE"), tokenFor("DISPATCH"), tokenFor("RND")]);
  const SENT: ItemStage[] = ["PRE_PRODUCTION", "IN_PRODUCTION", "FINISHED_GOODS", "DISPATCH", "COMPLETED"];

  console.log("PPIC tiles");
  const list = async (metric: string) => (await getAll(ppic, `/api/ppic/lists/${metric}`)).map((r) => keyOf(poOf(r), productOf(r)));
  report("Not Planned", keys(at("NOT_PLANNED")), await list("not-planned-pos"));
  report("Material Planning (short only)", keys(at("MATERIAL_SHORT")), uniq((await getAll(ppic, "/api/ppic/material-planning")).map((r) => keyOf(poOf(r), productOf(r)))));
  report("PO Readiness (all covered)", keys(at("READY_FOR_PRODUCTION")), (await getAll(ppic, "/api/ppic/ready-products")).map((r) => keyOf(poOf(r), productOf(r))));
  report("On Hold", keys(at("ON_HOLD")), await list("on-hold"));
  report("Cancelled", keys(at("CANCELLED")), await list("cancelled"));
  report("In Production / Plan sent", keys(at(...SENT)), await list("plan-sent"));
  report("Plan not sent", keys(rows.filter((r) => !r.planSent && ["NOT_PLANNED", "MATERIAL_SHORT", "READY_FOR_PRODUCTION", "ON_HOLD"].includes(r.stage))), await list("plan-not-sent"));
  report("Total products (approved POs, not cancelled)", keys(at("NOT_PLANNED", "MATERIAL_SHORT", "READY_FOR_PRODUCTION", "ON_HOLD", ...SENT)), await list("total-products"));

  const pendingRequests = await prisma.itemChangeRequest.count({ where: { status: "PENDING" } });
  report("BD Requests (open)", Array.from({ length: pendingRequests }, (_x, i) => `request ${i}`), (await getAll(ppic, "/api/item-change-requests")).map((_r, i) => `request ${i}`));

  console.log("QA / QC tiles");
  const board = async (stage: string) => (await getAll(qa, `/api/qc/board?stage=${stage}`)).map((r) => keyOf(r.poNumber, r.productName));
  // The preparation of each batch (per-batch flow): the batches waiting at one step, as products
  const prepExpected = async (stage: string, dayStoreId?: string) => {
    const batches = await prisma.productionBatch.findMany({
      where: { status: "IN_PROGRESS", prepStageId: stage as "INDENT_ISSUE", preProduction: { batchFlow: true, ...(dayStoreId ? { plant: { dayStoreId } } : {}) } },
      select: { preProduction: { select: { purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { poNumber: true } } } } } } },
    });
    return uniq(batches.map((b) => keyOf(b.preProduction.purchaseOrderItem.purchaseOrder.poNumber, b.preProduction.purchaseOrderItem.productName)));
  };
  const prepShown = async (token: string, stage: string) => uniq((await getAll(token, `/api/production-batches/prep-board?stage=${stage}`)).map((r) => keyOf(r.poNumber, r.productName)));
  report("IPQC", keys(rows.filter((r) => r.batchStages.includes("IPQC"))), await board("IPQC"));
  report("QA Gate: Manufacturing", keys(rows.filter((r) => r.batchStages.includes("QA_GATE_MFG"))), await board("QA_GATE_MFG"));
  report("QA Gate: Packaging", keys(rows.filter((r) => r.batchStages.includes("QA_GATE_PACKAGING"))), await board("QA_GATE_PACKAGING"));
  report("FG QC & Release", keys(rows.filter((r) => r.batchStages.includes("FG_QC_RELEASE"))), await board("FG_QC_RELEASE"));

  console.log("Production tiles");
  const prod = await tokenFor("PRODUCTION");
  const prodKeys = async (path: string, mapper: (r: any) => string = (r) => keyOf(r.poNumber, r.productName)) => (await getAll(prod, path)).map(mapper);
  report("New Plans (run not opened yet)", keys(rows.filter((r) => r.stage === "PRE_PRODUCTION" && !r.runStarted)), await prodKeys("/api/pre-productions/new-plans"));
  report("Indent Issue (batches waiting for the indent)", await prepExpected("INDENT_ISSUE"), await prepShown(prod, "INDENT_ISSUE"));
  report("Batch No (R&D, batches waiting for a number)", await prepExpected("BATCH_NO"), await prepShown(rnd, "BATCH_NO"));
  const atPackaging = await prisma.productionBatch.findMany({ where: { status: "COMPLETED", currentStageId: "PACKAGING" }, select: { preProduction: { select: { purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { poNumber: true } } } } } } } });
  report("Packaging (batches at Packaging)", uniq(atPackaging.map((b) => keyOf(b.preProduction.purchaseOrderItem.purchaseOrder.poNumber, b.preProduction.purchaseOrderItem.productName))), await prodKeys("/api/production-batches/packaging-board", (r) => keyOf(r.preProduction.purchaseOrderItem.purchaseOrder.poNumber, r.preProduction.purchaseOrderItem.productName)));
  report("Plans sent to Production (tracker)", keys(at(...SENT)), uniq(await prodKeys("/api/pre-productions/plans-board")));
  report("Handover to QA (packaging running / done / handed)", keys(rows.filter((r) => r.batchStages.some((b) => b === "PACKAGING" || b === "QA_GATE_PACKAGING"))), await prodKeys("/api/production-batches/handover-board"));

  console.log("Day Store tiles (each Day Store sees only its own plant's work)");
  const assignments = await prisma.dayStoreAssignment.findMany({ select: { userId: true, dayStoreId: true, dayStore: { select: { name: true } } }, distinct: ["dayStoreId"] });
  for (const a of assignments) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: a.userId }, include: { roles: { include: { role: true } } } });
    const t = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
    const mine = rows.filter((r) => r.dayStoreId === a.dayStoreId);
    const ds = async (path: string) => (await getAll(t, path)).map((r) => keyOf(r.poNumber, r.productName));
    report(`${a.dayStore.name}: Dispensing (batches with a batch number)`, await prepExpected("DISPENSING", a.dayStoreId), await prepShown(t, "DISPENSING"));
    report(`${a.dayStore.name}: FG Store (to receive)`, keys(mine.filter((r) => r.batchStages.includes("FG_STORE"))), await ds("/api/fg/store-board?stage=FG_STORE"));
    report(`${a.dayStore.name}: FG Handover (to Dispatch)`, keys(mine.filter((r) => r.batchStages.includes("FG_HANDOVER") && !r.handedOver)), await ds("/api/fg/store-board?stage=FG_HANDOVER"));
  }
  void store;

  console.log("Dispatch tiles");
  const toSend = (await getAll(dispatch, "/api/fg/dispatch-board")).map((r) => keyOf(r.poNumber, r.productName));
  report("Dispatch: to send", keys(rows.filter((r) => r.handedOver && r.remainingWithDispatch > 1e-6)), toSend);
  const withSent = (await getAll(dispatch, "/api/fg/dispatch-board?shipped=1")).map((r) => keyOf(r.poNumber, r.productName));
  report("Dispatch: everything handed over (incl. sent)", keys(rows.filter((r) => r.handedOver)), withSent);

  console.log("Warehouse tiles");
  const warehouse = await tokenFor("STORE");
  const received = await prisma.fgShipment.findMany({ where: { type: "WAREHOUSE", status: "RECEIVED", deletedAt: null }, select: { productionBatchId: true, quantity: true } });
  const receivedBatches = [...new Set(received.map((s) => s.productionBatchId))].sort();
  const fgList = (await getAll(warehouse, "/api/inventory/fg-list")).map((r) => String(r.id)).sort();
  report("Finished Goods (received from Dispatch)", receivedBatches, fgList);
  const fgRequests = (await getAll(warehouse, "/api/fg/warehouse-requests")).map((r) => String(r.id)).sort();
  const allWarehouseShipments = (await prisma.fgShipment.findMany({ where: { type: "WAREHOUSE", deletedAt: null }, select: { id: true } })).map((s) => s.id).sort();
  report("FG Requests (all Dispatch -> Warehouse)", allWarehouseShipments, fgRequests);

  const stockRequests = (await getAll(warehouse, "/api/fg/stock-requests")).map((r) => String(r.id)).sort();
  const allStockRequests = (await prisma.fgShipment.findMany({ where: { type: "FROM_WAREHOUSE", deletedAt: null }, select: { id: true } })).map((s) => s.id).sort();
  report("FG Stock Requests (Dispatch from Warehouse)", allStockRequests, stockRequests);
  // Warehouse stock = received from Dispatch less what it sent back
  const warehouseRows = await getAll(warehouse, "/api/inventory/fg-list");
  const stockMismatch: string[] = [];
  for (const r of warehouseRows) {
    const ships = await prisma.fgShipment.findMany({ where: { productionBatchId: String(r.id), deletedAt: null }, select: { type: true, status: true, quantity: true } });
    const expected = ships.filter((s) => s.type === "WAREHOUSE" && s.status === "RECEIVED").reduce((a, s) => a + s.quantity, 0) - ships.filter((s) => s.type === "FROM_WAREHOUSE" && (s.status === "SENT" || s.status === "RECEIVED")).reduce((a, s) => a + s.quantity, 0);
    if (Math.abs(Number(r.onHandQty) - expected) > 1e-6) stockMismatch.push(`${r.productName}: list ${r.onHandQty}, records ${expected}`);
  }
  report("Warehouse FG stock = received - sent back", [], stockMismatch);

  console.log(failures === 0 ? "\nEvery tile shows exactly its own products." : `\n${failures} tile(s) are wrong.`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
