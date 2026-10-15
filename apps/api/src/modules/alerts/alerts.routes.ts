import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";
import { computeDelay } from "../batches/batch.engine";
import { checkDataIntegrity } from "../ppic/data-integrity";
import { loadFinanceRows } from "../finance/finance.routes";

/**
 * GET /api/alerts   (Admin) everything in the system that needs attention, worked out live from the records (nothing is stored):
 *
 *   Late     orders past their promised delivery date, production runs / lots behind their plan dates, purchases past their ETA
 *   Stuck    waiting for more than STUCK_DAYS: Inward QC, material requests, Dispatch -> Warehouse requests, Regulatory review, BD requests
 *   Blocked  products on Hold, batches QA has put on Hold, rejected deliveries, products Regulatory did not approve
 *   Short    products whose material is short
 *
 * Each alert says what, for which PO / customer / product, why, since when, which department has to act, and where to open it.
 */
export const alertsRouter = Router();
alertsRouter.use(requireAuth, requireRole("ADMIN"));

const STUCK_DAYS = 3;
const DAY_MS = 86_400_000;

type Severity = "Late" | "Stuck" | "Blocked" | "Short";
interface Alert {
  key: string;
  severity: Severity;
  type: string;
  po: string | null;
  customer: string | null;
  product: string | null;
  detail: string;
  sinceAt: string | null;
  days: number;
  department: string;
  link: string;
}

const fmtQty = (n: number) => String(Math.round(n * 100) / 100);
const daysBetween = (from: Date, now: number) => Math.max(0, Math.floor((now - from.getTime()) / DAY_MS));

async function loadAlerts(): Promise<Alert[]> {
  const now = Date.now();
  const todayStart = new Date(new Date().toDateString()).getTime();
  const stuckBefore = new Date(now - STUCK_DAYS * DAY_MS);
  const alerts: Alert[] = [];
  const add = (a: Omit<Alert, "days"> & { days?: number }) => alerts.push({ ...a, days: a.days ?? (a.sinceAt ? daysBetween(new Date(a.sinceAt), now) : 0) });

  const itemSelect = { id: true, productName: true, materialHeldAt: true, regulatoryStatus: true, regulatoryReviewedAt: true, sentToRegulatoryAt: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } as const;
  const info = (item: { productName: string; purchaseOrder: { id: string; poNumber: string | null; customer: { companyName: string } } }) => ({ po: item.purchaseOrder.poNumber, customer: item.purchaseOrder.customer.companyName, product: item.productName, link: `/purchase-orders/${item.purchaseOrder.id}` });

  // --- Product stages: Hold, Short, and POs past their delivery date
  const report = await checkDataIntegrity();
  const stageOf = new Map(report.rows.map((r) => [r.id, r.stage]));
  const items = await prisma.purchaseOrderItem.findMany({ where: { deletedAt: null, id: { in: report.rows.map((r) => r.id) } }, select: itemSelect });
  for (const item of items) {
    const stage = stageOf.get(item.id);
    if (stage === "ON_HOLD") add({ key: `hold-${item.id}`, severity: "Blocked", type: "Product on hold", ...info(item), detail: "PPIC has put this product on hold. Release it or cancel it.", sinceAt: item.materialHeldAt?.toISOString() ?? null, department: "PPIC" });
    if (stage === "MATERIAL_SHORT") add({ key: `short-${item.id}`, severity: "Short", type: "Material short", ...info(item), detail: "A material this product needs is not covered by stock yet.", sinceAt: null, days: 0, department: "PPIC / Purchase" });
    if (item.regulatoryStatus === "Not Approved") add({ key: `reg-na-${item.id}`, severity: "Blocked", type: "Regulatory: not approved", ...info(item), detail: "Regulatory did not approve this product, so its plan cannot be sent to Production.", sinceAt: item.regulatoryReviewedAt?.toISOString() ?? null, department: "Regulatory / BD" });
    if (item.regulatoryStatus === null && item.sentToRegulatoryAt && item.sentToRegulatoryAt < stuckBefore && stage !== "CANCELLED") {
      add({ key: `reg-wait-${item.id}`, severity: "Stuck", type: "Regulatory review waiting", ...info(item), detail: `Waiting for Regulatory to review for ${daysBetween(item.sentToRegulatoryAt, now)} days.`, sinceAt: item.sentToRegulatoryAt.toISOString(), department: "Regulatory" });
    }
  }

  const delayedPos = await prisma.purchaseOrder.findMany({ where: { status: "APPROVED", expectedDeliveryDate: { lt: new Date(todayStart) } }, select: { id: true, poNumber: true, expectedDeliveryDate: true, customer: { select: { companyName: true } } } });
  for (const po of delayedPos) {
    const open = report.rows.filter((r) => r.po === po.poNumber && !["COMPLETED", "CANCELLED", "PO_NOT_APPROVED"].includes(r.stage));
    if (open.length === 0) continue;
    add({ key: `po-late-${po.id}`, severity: "Late", type: "PO past delivery date", po: po.poNumber, customer: po.customer.companyName, product: open.length === 1 ? open[0]!.product : `${open.length} products`, detail: `Promised for ${po.expectedDeliveryDate!.toISOString().slice(0, 10)}; ${open.length} product(s) not completed.`, sinceAt: po.expectedDeliveryDate!.toISOString(), department: "PPIC / Production", link: `/purchase-orders/${po.id}` });
  }

  // --- Production runs and lots behind their plan dates
  const runs = await prisma.preProduction.findMany({
    where: { productionPlanDate: { lt: new Date(now) } },
    select: { id: true, currentStageId: true, productionPlanDate: true, dispatchPlanDate: true, productionBatches: { select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 }, purchaseOrderItem: { select: itemSelect } },
  });
  for (const run of runs) {
    const delay = computeDelay({ dispatchDate: null, dispatchPlanDate: null, manufacturingStartDate: run.productionBatches[0]?.createdAt ?? null, productionPlanDate: run.productionPlanDate });
    if (!delay.isDelayed || stageOf.get(run.purchaseOrderItem.id) === "CANCELLED") continue;
    add({ key: `run-late-${run.id}`, severity: "Late", type: "Production run late", ...info(run.purchaseOrderItem), detail: `Production was planned for ${run.productionPlanDate!.toISOString().slice(0, 10)} and has not started (now at ${run.currentStageId.replace(/_/g, " ").toLowerCase()}).`, sinceAt: run.productionPlanDate!.toISOString(), department: "Production", link: `/pre-productions/${run.id}` });
  }
  const lots = await prisma.combinedLot.findMany({ where: { dispatchDate: null, preProduction: { dispatchPlanDate: { lt: new Date(now) } } }, select: { id: true, currentStageId: true, preProduction: { select: { dispatchPlanDate: true, purchaseOrderItem: { select: itemSelect } } } } });
  for (const lot of lots) {
    add({ key: `lot-late-${lot.id}`, severity: "Late", type: "Lot behind dispatch plan", ...info(lot.preProduction.purchaseOrderItem), detail: `Dispatch was planned for ${lot.preProduction.dispatchPlanDate!.toISOString().slice(0, 10)} (lot at ${lot.currentStageId.replace(/_/g, " ").toLowerCase()}).`, sinceAt: lot.preProduction.dispatchPlanDate!.toISOString(), department: "Production / Dispatch", link: `/combined-lots/${lot.id}` });
  }

  // --- Purchases past their ETA
  const lines = await prisma.requirementPurchaseLine.findMany({ where: { status: "OPEN", eta: { lt: new Date(todayStart) } }, select: { id: true, quantity: true, receivedQty: true, piNumber: true, vendorName: true, eta: true, requirement: { select: { item: { select: { name: true, unit: true } } } } } });
  for (const l of lines) {
    add({ key: `eta-${l.id}`, severity: "Late", type: "Purchase past ETA", po: null, customer: null, product: l.requirement.item.name, detail: `${fmtQty(l.quantity - l.receivedQty)} ${l.requirement.item.unit ?? ""} from ${l.vendorName} (${l.piNumber}) was due ${l.eta.toISOString().slice(0, 10)} and has not arrived.`, sinceAt: l.eta.toISOString(), department: "Purchase", link: "/incoming-material" });
  }

  // --- Waiting too long
  const receipts = await prisma.inventoryTransaction.findMany({ where: { type: "RECEIVED", deletedAt: null, receiptStatus: { in: ["PENDING_QC", "TESTING", "ON_HOLD"] }, date: { lt: stuckBefore } }, select: { id: true, date: true, quantity: true, unit: true, receiptStatus: true, vendorName: true, item: { select: { name: true } } } });
  for (const t of receipts) {
    const label = t.receiptStatus === "PENDING_QC" ? "waiting to be sampled" : t.receiptStatus === "TESTING" ? "still in testing" : "on hold";
    add({ key: `inward-${t.id}`, severity: "Stuck", type: "Inward QC waiting", po: null, customer: null, product: t.item.name, detail: `${fmtQty(t.quantity)} ${t.unit} from ${t.vendorName ?? "a vendor"} is ${label} for ${daysBetween(t.date, now)} days.`, sinceAt: t.date.toISOString(), department: "R&D (Inward QC)", link: "/inward-qc" });
  }
  const rejected = await prisma.inventoryTransaction.findMany({ where: { type: "RECEIVED", deletedAt: null, receiptStatus: "QC_REJECTED" }, select: { id: true, date: true, qcCheckedAt: true, quantity: true, unit: true, qcNote: true, vendorName: true, item: { select: { name: true } } } });
  for (const t of rejected) {
    add({ key: `rejected-${t.id}`, severity: "Blocked", type: "Rejected delivery", po: null, customer: null, product: t.item.name, detail: `${fmtQty(t.quantity)} ${t.unit} from ${t.vendorName ?? "a vendor"} was rejected${t.qcNote ? `: ${t.qcNote}` : ""}.`, sinceAt: (t.qcCheckedAt ?? t.date).toISOString(), department: "Warehouse / Purchase", link: "/quarantine" });
  }
  const requests = await prisma.inventoryRequest.findMany({ where: { deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] }, createdAt: { lt: stuckBefore } }, select: { id: true, createdAt: true, requestedQty: true, status: true, purpose: true, isExtra: true, item: { select: { name: true, unit: true } }, requestedBy: { select: { fullName: true } } } });
  for (const r of requests) {
    add({ key: `request-${r.id}`, severity: "Stuck", type: r.isExtra ? "Extra material request waiting" : "Material request waiting", po: null, customer: null, product: r.item.name, detail: `${fmtQty(r.requestedQty)} ${r.item.unit ?? ""} requested by ${r.requestedBy.fullName} is ${r.status.toLowerCase().replace("_", " ")} for ${daysBetween(r.createdAt, now)} days.`, sinceAt: r.createdAt.toISOString(), department: "Warehouse", link: "/material-requests" });
  }
  const shipments = await prisma.fgShipment.findMany({ where: { type: { in: ["WAREHOUSE", "FROM_WAREHOUSE"] }, deletedAt: null, status: { in: ["REQUESTED", "ACCEPTED", "SENT"] }, requestedAt: { lt: stuckBefore } }, select: { id: true, requestedAt: true, quantity: true, status: true, type: true, productionBatch: { select: { batchNo: true, preProduction: { select: { purchaseOrderItem: { select: itemSelect } } } } } } });
  for (const s of shipments) {
    const item = s.productionBatch.preProduction.purchaseOrderItem;
    const back = s.type === "FROM_WAREHOUSE";
    const who = back
      ? s.status === "REQUESTED"
        ? "Warehouse has not sent it to Dispatch"
        : "Dispatch has not confirmed receiving it"
      : s.status === "REQUESTED"
        ? "Warehouse has not accepted it"
        : s.status === "ACCEPTED"
          ? "Dispatch has not sent it"
          : "Warehouse has not confirmed receiving it";
    add({ key: `fg-${s.id}`, severity: "Stuck", type: back ? "FG stock request waiting" : "FG request waiting", ...info(item), link: back ? "/finished-goods" : "/fg-warehouse-requests", detail: `${fmtQty(s.quantity)} finished goods${s.productionBatch.batchNo ? ` (batch ${s.productionBatch.batchNo})` : ""}: ${who} for ${daysBetween(s.requestedAt, now)} days.`, sinceAt: s.requestedAt.toISOString(), department: back ? (s.status === "REQUESTED" ? "Warehouse" : "Dispatch") : s.status === "ACCEPTED" ? "Dispatch" : "Warehouse" });
  }
  // Customer shipments waiting for Accounts (over the limit), or sent back to Dispatch to correct
  const customerShipments = await prisma.fgShipment.findMany({
    where: { type: "CUSTOMER", deletedAt: null, OR: [{ status: "WITH_ACCOUNTS", requestedAt: { lt: stuckBefore } }, { status: "SENT_BACK" }] },
    select: { id: true, requestedAt: true, quantity: true, status: true, rejectedReason: true, productionBatch: { select: { batchNo: true, preProduction: { select: { purchaseOrderItem: { select: itemSelect } } } } } },
  });
  for (const s of customerShipments) {
    const item = s.productionBatch.preProduction.purchaseOrderItem;
    const back = s.status === "SENT_BACK";
    add({ key: `cust-${s.id}`, severity: "Stuck", type: back ? "Shipment sent back to Dispatch" : "Shipment waiting for Accounts", ...info(item), link: back ? "/finished-goods-dispatch" : "/accounts-dispatch", detail: back ? `${fmtQty(s.quantity)} for the customer was sent back by Accounts: ${s.rejectedReason ?? "needs a correction"}.` : `${fmtQty(s.quantity)} for the customer has waited for Accounts' invoice for ${daysBetween(s.requestedAt, now)} days.`, sinceAt: s.requestedAt.toISOString(), department: back ? "Dispatch" : "Accounts" });
  }
  const changes = await prisma.itemChangeRequest.findMany({ where: { status: "PENDING", requestedAt: { lt: stuckBefore } }, select: { id: true, kind: true, reason: true, requestedAt: true, purchaseOrderItem: { select: itemSelect } } });
  for (const c of changes) {
    add({ key: `change-${c.id}`, severity: "Stuck", type: "BD request waiting", ...info(c.purchaseOrderItem), link: "/bd-requests", detail: `BD asked to ${c.kind === "HOLD" ? "hold" : "cancel"} this product (${c.reason}); PPIC has not answered for ${daysBetween(c.requestedAt, now)} days.`, sinceAt: c.requestedAt.toISOString(), department: "PPIC" });
  }

  // --- Finance: a short RM / PM whose vendor, PO number and ETA Purchase logged, still waiting for Finance's decision (or its remark has gone stale)
  for (const f of await loadFinanceRows()) {
    if (f.status !== "PENDING" || f.waitingDays <= STUCK_DAYS) continue;
    add({ key: `finance-${f.lineId}`, severity: "Stuck", type: "Vendor payment waiting for Finance", po: f.piNumber, customer: f.customerPo?.customerName ?? null, product: f.itemName, detail: `${fmtQty(f.shortQty)} ${f.unit} short; ${f.vendorName} (${f.piNumber}), ETA ${f.eta.toISOString().slice(0, 10)}: Finance has not paid, held or rejected it for ${f.waitingDays} days.`, sinceAt: f.loggedAt.toISOString(), department: "Accounts", link: "/vendor-payments" });
  }

  // --- QA holds on a batch
  const heldBatches = await prisma.productionBatch.findMany({
    where: { OR: [{ mfgQaStatus: "Hold" }, { mfgQcStatus: "Hold" }, { packQaStatus: "Hold" }, { packQcStatus: "Hold" }, { fgQaStatus: "Hold" }, { fgQcStatus: "Hold" }] },
    select: { id: true, batchNo: true, currentStageId: true, updatedAt: true, preProduction: { select: { purchaseOrderItem: { select: itemSelect } } } },
  });
  for (const b of heldBatches) {
    add({ key: `qa-hold-${b.id}`, severity: "Blocked", type: "Batch on QA hold", ...info(b.preProduction.purchaseOrderItem), link: `/production-batches/${b.id}`, detail: `Batch ${b.batchNo ?? ""} is on hold at ${b.currentStageId.replace(/_/g, " ").toLowerCase()}.`.replace("Batch  ", "Batch "), sinceAt: b.updatedAt.toISOString(), department: "QA / QC" });
  }

  const order: Record<Severity, number> = { Late: 0, Blocked: 1, Stuck: 2, Short: 3 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || b.days - a.days);
}

alertsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await loadAlerts());
  } catch (err) {
    next(err);
  }
});

alertsRouter.get("/summary", async (_req, res, next) => {
  try {
    const rows = await loadAlerts();
    res.json({ total: rows.length, late: rows.filter((r) => r.severity === "Late").length, stuck: rows.filter((r) => r.severity === "Stuck").length, blocked: rows.filter((r) => r.severity === "Blocked").length, short: rows.filter((r) => r.severity === "Short").length });
  } catch (err) {
    next(err);
  }
});
