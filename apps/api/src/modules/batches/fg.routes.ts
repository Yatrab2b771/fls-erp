import { Router, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { getScopedDayStoreIds, requireWarehouseSeat } from "../inventory/day-store-access";

/**
 * Finished goods, after Packaging.
 *
 *   Day Store   receives the finished goods (FG_STORE), QA approves them (FG_QC_RELEASE), the Day Store hands them to Dispatch
 *               (FG_HANDOVER) - those stage moves use PATCH /production-batches/:id/stage; GET /store-board lists them here.
 *   Dispatch    sees what is handed over (GET /dispatch-board) and ships it in parts, to the customer (POST /customer-shipments) or to the
 *               Warehouse: first a request saying how much is coming (POST /warehouse-requests), the Warehouse accepts it, Dispatch sends
 *               it, the Warehouse confirms it arrived (RECEIVED = Warehouse finished-goods stock).
 *   Accounts    may add an invoice / e-way bill to a customer shipment any time (optional).
 *
 * What is left with Dispatch for a batch = its approved quantity less every shipment that is not rejected or removed.
 */
export const fgRouter = Router();
fgRouter.use(requireAuth);

const EPS = 1e-6;
const round = (n: number) => Math.round(n * 1000) / 1000;
const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);

const batchSelect = {
  id: true,
  batchNo: true,
  currentStageId: true,
  outputQty: true,
  packApprovedQty: true,
  fgStoreReceivedDate: true,
  fgStoreRemarks: true,
  fgQaStatus: true,
  fgQcStatus: true,
  fgRemarks: true,
  handedOverToDispatchAt: true,
  updatedAt: true,
  fgShipments: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
  customerReturns: { select: { status: true, passedQty: true } },
  preProduction: {
    select: {
      id: true,
      plantId: true,
      plant: { select: { id: true, name: true, dayStoreId: true } },
      purchaseOrderItem: {
        select: { id: true, productName: true, productCategory: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { id: true, companyName: true } } } } },
      },
    },
  },
} satisfies Prisma.ProductionBatchSelect;
type BatchRow = Prisma.ProductionBatchGetPayload<{ select: typeof batchSelect }>;

/** Approved finished quantity of a batch: what QA passed at the packaging gate, else what it produced. */
const approvedQtyOf = (b: { packApprovedQty: number | null; outputQty: number | null }) => b.packApprovedQty ?? b.outputQty ?? 0;
const ACTIVE_STATUSES = ["REQUESTED", "ACCEPTED", "SENT", "RECEIVED", "DISPATCHED", "WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK"];
/** A customer shipment still on its way to being sent: Dispatch fills it, Accounts adds the invoice, then Dispatch sends it. */
const PENDING_CUSTOMER = ["WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK"] as const;
// Dispatch's own stock of a batch: shipments out (to the customer / the Warehouse), less what the Warehouse has sent back to it.
// A customer return QA passed is back in Dispatch's stock of the batch (when Dispatch stored it in the Warehouse, that is a transfer out of it again).
const RETURNED_TO_DISPATCH = ["AWAITING_DISPATCH", "TO_BE_RESENT", "STORED"];
const shippedOf = (b: BatchRow) =>
  b.fgShipments.filter((s) => s.type !== "FROM_WAREHOUSE" && ACTIVE_STATUSES.includes(s.status)).reduce((sum, s) => sum + s.quantity, 0) -
  b.fgShipments.filter((s) => s.type === "FROM_WAREHOUSE" && s.status === "RECEIVED").reduce((sum, s) => sum + s.quantity, 0) -
  b.customerReturns.filter((r) => RETURNED_TO_DISPATCH.includes(r.status)).reduce((sum, r) => sum + (r.passedQty ?? 0), 0);
/** What the Warehouse holds of a batch: received from Dispatch, less what it has sent back or is asked to send back (held for the request). */
const warehouseHeldOf = (b: BatchRow, includeRequested: boolean) =>
  b.fgShipments.filter((s) => s.type === "WAREHOUSE" && s.status === "RECEIVED").reduce((sum, s) => sum + s.quantity, 0) -
  b.fgShipments
    .filter((s) => s.type === "FROM_WAREHOUSE" && (s.status === "SENT" || s.status === "RECEIVED" || (includeRequested && s.status === "REQUESTED")))
    .reduce((sum, s) => sum + s.quantity, 0);

function serializeShipment(s: BatchRow["fgShipments"][number]) {
  return {
    id: s.id,
    type: s.type,
    status: s.status,
    quantity: s.quantity,
    note: s.note,
    requestedAt: s.requestedAt,
    acceptedAt: s.acceptedAt,
    rejectedReason: s.rejectedReason,
    sentAt: s.sentAt,
    receivedAt: s.receivedAt,
    dispatchDate: s.dispatchDate,
    transportType: s.transportType,
    pickedBy: s.pickedBy,
    pickingDate: s.pickingDate,
    loadedBy: s.loadedBy,
    loadingDate: s.loadingDate,
    remarks: s.remarks,
    transportName: s.transportName,
    vehicleNo: s.vehicleNo,
    lrNo: s.lrNo,
    weightKg: s.weightKg,
    cartonCount: s.cartonCount,
    goodsValue: s.goodsValue,
    freightCharge: s.freightCharge,
    insuranceCharge: s.insuranceCharge,
    invoiceAmount: s.invoiceAmount,
    invoiceNo: s.invoiceNo,
    invoiceDate: s.invoiceDate,
    ewayBillNo: s.ewayBillNo,
    ewayBillDate: s.ewayBillDate,
  };
}

function serializeBatch(b: BatchRow) {
  const item = b.preProduction.purchaseOrderItem;
  const approved = round(approvedQtyOf(b));
  const shipped = round(shippedOf(b));
  return {
    batchId: b.id,
    batchNo: b.batchNo,
    poId: item.purchaseOrder.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    productName: item.productName,
    productCategory: item.productCategory,
    unit: item.unit,
    plantName: b.preProduction.plant?.name ?? null,
    currentStageId: b.currentStageId,
    approvedQty: approved,
    shippedQty: shipped,
    remainingQty: Math.max(0, round(approved - shipped)),
    fgStoreReceivedDate: b.fgStoreReceivedDate,
    fgStoreRemarks: b.fgStoreRemarks,
    fgQaStatus: b.fgQaStatus,
    fgQcStatus: b.fgQcStatus,
    fgRemarks: b.fgRemarks,
    handedOverAt: b.handedOverToDispatchAt,
    waitingSince: b.updatedAt,
    shipments: b.fgShipments.map(serializeShipment),
  };
}

// --- The Day Store's / QA's list: batches at FG_STORE (to receive), FG_QC_RELEASE (QA approval) or FG_HANDOVER (to hand over) ---
fgRouter.get("/store-board", requireRole("STORE", "QA_QC", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const stage = req.query.stage === "FG_QC_RELEASE" ? "FG_QC_RELEASE" : req.query.stage === "FG_HANDOVER" ? "FG_HANDOVER" : "FG_STORE";
    const scope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: {
        currentStageId: stage,
        ...(stage === "FG_HANDOVER" ? { handedOverToDispatchAt: null } : {}),
        ...(scope ? { preProduction: { plant: { dayStoreId: { in: scope } } } } : {}),
      },
      select: batchSelect,
      orderBy: { updatedAt: "asc" },
    });
    res.json(batches.map(serializeBatch));
  } catch (err) {
    next(err);
  }
});

// --- Dispatch: what has been handed over to it, with what is left ---
fgRouter.get("/dispatch-board", requireRole("DISPATCH", "PPIC", "ACCOUNTS"), async (req: AuthedRequest, res, next) => {
  try {
    const showShipped = req.query.shipped === "1";
    const batches = await prisma.productionBatch.findMany({
      where: { currentStageId: "FG_HANDOVER", handedOverToDispatchAt: { not: null } },
      select: batchSelect,
      orderBy: { handedOverToDispatchAt: "asc" },
    });
    const rows = batches.map(serializeBatch).filter((r) => showShipped || r.remainingQty > EPS || r.shipments.some((s) => ["REQUESTED", "ACCEPTED", ...PENDING_CUSTOMER].includes(s.status)));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function loadHandedOver(batchId: string): Promise<BatchRow | null> {
  const batch = await prisma.productionBatch.findUnique({ where: { id: batchId }, select: batchSelect });
  if (!batch || batch.currentStageId !== "FG_HANDOVER" || !batch.handedOverToDispatchAt) return null;
  return batch;
}

const dateField = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.date().optional());
const amountField = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().nonnegative().optional());
const shipmentDetailsSchema = z.object({
  quantity: z.coerce.number().positive(),
  dispatchDate: dateField,
  transportType: z.string().max(60).optional(),
  pickedBy: z.string().max(200).optional(),
  pickingDate: dateField,
  loadedBy: z.string().max(200).optional(),
  loadingDate: dateField,
  remarks: z.string().max(1000).optional(),
  transportName: z.string().trim().max(200).optional(),
  vehicleNo: z.string().trim().max(60).optional(),
  lrNo: z.string().trim().max(120).optional(),
  weightKg: amountField,
  cartonCount: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().nonnegative().optional()),
  goodsValue: amountField,
  freightCharge: amountField,
  insuranceCharge: amountField,
  invoiceNo: z.string().max(120).optional(),
  invoiceDate: dateField,
  ewayBillNo: z.string().max(120).optional(),
  ewayBillDate: dateField,
});

/** Insurance is 0.1% of the goods value unless Dispatch entered its own figure. */
const INSURANCE_RATE = 0.001;
const withInsurance = <T extends { goodsValue?: number; insuranceCharge?: number }>(d: T): T => (d.insuranceCharge === undefined && d.goodsValue !== undefined ? { ...d, insuranceCharge: Math.round(d.goodsValue * INSURANCE_RATE * 100) / 100 } : d);

// --- Dispatch sends finished goods to the customer (a part is fine; the rest stays with Dispatch) ---
fgRouter.post("/batches/:id/customer-shipments", requireRole("DISPATCH"), validateBody(shipmentDetailsSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadHandedOver(req.params.id);
    if (!batch) return res.status(404).json({ error: "These finished goods are not with Dispatch (yet)." });
    const input = withInsurance(req.body as z.infer<typeof shipmentDetailsSchema>);
    const remaining = approvedQtyOf(batch) - shippedOf(batch);
    if (input.quantity > remaining + EPS) return res.status(409).json({ error: `Only ${round(remaining)} is left with Dispatch for this batch.` });
    // It goes to Accounts first: they add the invoice and e-way bill, and only then can Dispatch send it
    const shipment = await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "CUSTOMER", status: "WITH_ACCOUNTS", requestedById: req.user!.id, ...input, dispatchDate: input.dispatchDate ?? new Date() } });
    const item = batch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.sent_to_accounts", entityType: "ProductionBatch", entityId: batch.id, metadata: { shipmentId: shipment.id, quantity: input.quantity } });
    await notifyRoles(["ACCOUNTS"], { title: `Dispatch needs an invoice: ${item.productName}`, body: `${input.quantity} ${item.unit}${batch.batchNo ? ` (batch ${batch.batchNo})` : ""} for ${item.purchaseOrder.customer.companyName} - add the invoice and e-way bill so Dispatch can send it.`, link: "/accounts-dispatch" }, req.user!.id).catch(() => {});
    res.status(201).json(serializeShipment(shipment));
  } catch (err) {
    next(err);
  }
});

// --- Accounts: add the invoice / e-way bill (then it is ready to send) or send it back to Dispatch with a reason ---
const accountsSchema = z.object({
  invoiceNo: z.string().trim().min(1, "Enter the invoice number.").max(120),
  invoiceDate: dateField,
  invoiceAmount: amountField,
  ewayBillNo: z.string().trim().max(120).optional(),
  ewayBillDate: dateField,
});
fgRouter.post("/shipments/:id/accounts-approve", requireRole("ACCOUNTS"), validateBody(accountsSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "CUSTOMER") return res.status(404).json({ error: "Shipment not found" });
    if (shipment.status !== "WITH_ACCOUNTS" && shipment.status !== "READY_TO_SEND") return res.status(409).json({ error: shipment.status === "SENT_BACK" ? "It is with Dispatch to correct." : `This shipment is already ${shipment.status.toLowerCase().replace(/_/g, " ")}.` });
    const input = req.body as z.infer<typeof accountsSchema>;
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { ...input, status: "READY_TO_SEND", acceptedById: req.user!.id, acceptedAt: new Date(), rejectedReason: null } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.accounts_approved", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id, invoiceNo: input.invoiceNo } });
    await notifyRoles(["DISPATCH"], { title: `Ready to send: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - Accounts added invoice ${input.invoiceNo}. You can send it to the customer.`, link: "/finished-goods-dispatch" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

const returnSchema = z.object({ reason: z.string().trim().min(1, "Say what Dispatch has to correct.").max(500) });
fgRouter.post("/shipments/:id/accounts-return", requireRole("ACCOUNTS"), validateBody(returnSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "CUSTOMER") return res.status(404).json({ error: "Shipment not found" });
    if (shipment.status !== "WITH_ACCOUNTS") return res.status(409).json({ error: `This shipment is already ${shipment.status.toLowerCase().replace(/_/g, " ")}.` });
    const { reason } = req.body as z.infer<typeof returnSchema>;
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "SENT_BACK", rejectedReason: reason, acceptedById: req.user!.id, acceptedAt: new Date() } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.accounts_returned", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(["DISPATCH"], { title: `Accounts sent it back: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - ${reason}`, link: "/finished-goods-dispatch" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Dispatch corrects a shipment Accounts sent back and submits it again
fgRouter.post("/shipments/:id/resubmit", requireRole("DISPATCH"), validateBody(shipmentDetailsSchema.omit({ quantity: true }).partial()), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "CUSTOMER") return res.status(404).json({ error: "Shipment not found" });
    if (shipment.status !== "SENT_BACK") return res.status(409).json({ error: "Only a shipment Accounts sent back can be submitted again." });
    const details = withInsurance(req.body as Record<string, unknown> as { goodsValue?: number; insuranceCharge?: number });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { ...details, status: "WITH_ACCOUNTS", rejectedReason: null } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.resubmitted", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(["ACCOUNTS"], { title: `Dispatch corrected it: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - add the invoice and e-way bill.`, link: "/accounts-dispatch" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Once Accounts has approved it, Dispatch sends it to the customer
fgRouter.post("/shipments/:id/send-to-customer", requireRole("DISPATCH"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "CUSTOMER") return res.status(404).json({ error: "Shipment not found" });
    if (shipment.status !== "READY_TO_SEND") return res.status(409).json({ error: shipment.status === "DISPATCHED" ? "Already sent." : "Accounts has not approved this yet." });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "DISPATCHED", sentById: req.user!.id, sentAt: new Date(), dispatchDate: shipment.dispatchDate ?? new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.customer_dispatched", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id, quantity: shipment.quantity } });
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Dispatch's and Accounts' list of customer shipments still on their way to being sent
fgRouter.get("/accounts-queue", requireRole("ACCOUNTS", "DISPATCH", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    await listWarehouseShipments(req, res, "CUSTOMER");
  } catch (err) {
    next(err);
  }
});

// --- Dispatch tells the Warehouse how much it wants to send (nothing is sent before the Warehouse accepts) ---
const warehouseRequestSchema = shipmentDetailsSchema.extend({ note: z.string().max(500).optional() });
fgRouter.post("/batches/:id/warehouse-requests", requireRole("DISPATCH"), validateBody(warehouseRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadHandedOver(req.params.id);
    if (!batch) return res.status(404).json({ error: "These finished goods are not with Dispatch (yet)." });
    const { quantity, note, ...details } = withInsurance(req.body as z.infer<typeof warehouseRequestSchema>);
    const remaining = approvedQtyOf(batch) - shippedOf(batch);
    if (quantity > remaining + EPS) return res.status(409).json({ error: `Only ${round(remaining)} is left with Dispatch for this batch.` });
    const shipment = await prisma.fgShipment.create({ data: { ...details, productionBatchId: batch.id, type: "WAREHOUSE", status: "REQUESTED", quantity, note, requestedById: req.user!.id } });
    const item = batch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.warehouse_requested", entityType: "ProductionBatch", entityId: batch.id, metadata: { shipmentId: shipment.id, quantity } });
    await notifyRoles(
      ["STORE"],
      { title: `Dispatch wants to send finished goods: ${item.productName}`, body: `${quantity} ${item.unit}${batch.batchNo ? ` (batch ${batch.batchNo})` : ""} - accept to receive it.`, link: "/fg-warehouse-requests" },
      req.user!.id,
    ).catch(() => {});
    res.status(201).json(serializeShipment(shipment));
  } catch (err) {
    next(err);
  }
});

async function loadShipment(id: string) {
  return prisma.fgShipment.findFirst({ where: { id, deletedAt: null }, include: { productionBatch: { select: batchSelect } } });
}

// Dispatch withdraws a request the Warehouse has not received yet
fgRouter.delete("/shipments/:id", requireRole("DISPATCH"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    if (!((shipment.type === "WAREHOUSE" && ["REQUESTED", "ACCEPTED"].includes(shipment.status)) || (shipment.type === "FROM_WAREHOUSE" && shipment.status === "REQUESTED") || (shipment.type === "CUSTOMER" && (PENDING_CUSTOMER as readonly string[]).includes(shipment.status)))) return res.status(409).json({ error: "Only a request that has not been sent can be withdrawn." });
    await prisma.fgShipment.update({ where: { id: shipment.id }, data: { deletedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.withdrawn", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// The Warehouse accepts / refuses the request
const decisionSchema = z.object({ action: z.enum(["ACCEPT", "REJECT"]), reason: z.string().max(500).optional() });
fgRouter.patch("/shipments/:id/decision", requireRole("STORE"), requireWarehouseSeat, validateBody(decisionSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "REQUESTED") return res.status(409).json({ error: `This request is already ${shipment.status.toLowerCase()}.` });
    const { action, reason } = req.body as z.infer<typeof decisionSchema>;
    if (action === "REJECT" && !reason?.trim()) return res.status(400).json({ error: "Give a reason for refusing." });
    const updated = await prisma.fgShipment.update({
      where: { id: shipment.id },
      data: action === "ACCEPT" ? { status: "ACCEPTED", acceptedById: req.user!.id, acceptedAt: new Date() } : { status: "REJECTED", acceptedById: req.user!.id, acceptedAt: new Date(), rejectedReason: reason!.trim() },
    });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: action === "ACCEPT" ? "fg_shipment.accepted" : "fg_shipment.rejected", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(
      ["DISPATCH"],
      action === "ACCEPT"
        ? { title: `Warehouse accepted: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - you can send it now.`, link: "/finished-goods-dispatch" }
        : { title: `Warehouse refused: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - ${reason!.trim()}`, link: "/finished-goods-dispatch" },
      req.user!.id,
    ).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Dispatch sends an accepted request
fgRouter.post("/shipments/:id/send", requireRole("DISPATCH"), validateBody(shipmentDetailsSchema.omit({ quantity: true })), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "ACCEPTED") return res.status(409).json({ error: shipment.status === "REQUESTED" ? "The Warehouse has not accepted this yet." : `This request is already ${shipment.status.toLowerCase()}.` });
    const details = withInsurance(req.body as Omit<z.infer<typeof shipmentDetailsSchema>, "quantity">);
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { ...details, dispatchDate: details.dispatchDate ?? new Date(), status: "SENT", sentById: req.user!.id, sentAt: new Date() } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.sent_to_warehouse", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(["STORE"], { title: `Finished goods on the way: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - confirm once it arrives.`, link: "/fg-warehouse-requests" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// The Warehouse confirms it arrived: from here it is Warehouse finished-goods stock
fgRouter.post("/shipments/:id/receive", requireRole("STORE"), requireWarehouseSeat, async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "SENT") return res.status(409).json({ error: shipment.status === "RECEIVED" ? "Already received." : "Dispatch has not sent this yet." });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "RECEIVED", receivedById: req.user!.id, receivedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.received", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Accounts (or Dispatch) adds the invoice / e-way bill to a customer shipment - optional, any time
const invoiceSchema = z.object({ invoiceNo: z.string().max(120).optional(), invoiceDate: dateField, ewayBillNo: z.string().max(120).optional(), ewayBillDate: dateField });
fgRouter.patch("/shipments/:id/invoice", requireRole("ACCOUNTS", "DISPATCH"), validateBody(invoiceSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "CUSTOMER") return res.status(404).json({ error: "Customer shipment not found" });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: req.body as z.infer<typeof invoiceSchema> });
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.invoice_added", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// --- The Warehouse's list of finished-goods requests (also what Dispatch and PPIC follow) ---
async function listWarehouseShipments(req: AuthedRequest, res: Response, type: "WAREHOUSE" | "FROM_WAREHOUSE" | "CUSTOMER") {
  type AnyStatus = "REQUESTED" | "ACCEPTED" | "REJECTED" | "SENT" | "RECEIVED" | "DISPATCHED" | "WITH_ACCOUNTS" | "READY_TO_SEND" | "SENT_BACK";
  const statuses = many(req.query.status).filter((s) => ["REQUESTED", "ACCEPTED", "REJECTED", "SENT", "RECEIVED", "DISPATCHED", "WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK"].includes(s));
  // a customer list is the shipments still to be sent, unless a status is asked for
  const wanted = statuses.length ? (statuses as AnyStatus[]) : type === "CUSTOMER" ? [...PENDING_CUSTOMER] : [];
  const shipments = await prisma.fgShipment.findMany({
    where: { type, deletedAt: null, ...(wanted.length ? { status: { in: wanted } } : {}) },
    orderBy: { requestedAt: "desc" },
    include: { productionBatch: { select: { id: true, batchNo: true, preProduction: { select: { plant: { select: { name: true } }, purchaseOrderItem: { select: { productName: true, unit: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } } } } } } },
  });
  res.json(
    shipments.map((s) => {
      const item = s.productionBatch.preProduction.purchaseOrderItem;
      return {
        ...serializeShipment(s),
        batchId: s.productionBatchId,
        batchNo: s.productionBatch.batchNo,
        productName: item.productName,
        unit: item.unit,
        poNumber: item.purchaseOrder.poNumber,
        customerName: item.purchaseOrder.customer.companyName,
        plantName: s.productionBatch.preProduction.plant?.name ?? null,
      };
    }),
  );
}

// --- Dispatch asks the Warehouse for finished goods it holds (to send to a customer): the Warehouse sends them back, Dispatch confirms ---
const stockRequestSchema = z.object({ quantity: z.coerce.number().positive(), note: z.string().max(500).optional() });
fgRouter.post("/batches/:id/stock-requests", requireRole("DISPATCH"), validateBody(stockRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadHandedOver(req.params.id);
    if (!batch) return res.status(404).json({ error: "These finished goods are not with Dispatch (yet)." });
    const { quantity, note } = req.body as z.infer<typeof stockRequestSchema>;
    const held = warehouseHeldOf(batch, true);
    if (quantity > held + EPS) return res.status(409).json({ error: held > EPS ? `Only ${round(held)} of this batch is in the Warehouse (less what is already asked for).` : "The Warehouse holds none of this batch." });
    const shipment = await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "FROM_WAREHOUSE", status: "REQUESTED", quantity, note, requestedById: req.user!.id } });
    const item = batch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.stock_requested", entityType: "ProductionBatch", entityId: batch.id, metadata: { shipmentId: shipment.id, quantity } });
    await notifyRoles(["STORE"], { title: `Dispatch needs finished goods: ${item.productName}`, body: `${quantity} ${item.unit}${batch.batchNo ? ` (batch ${batch.batchNo})` : ""} - send it to Dispatch.`, link: "/finished-goods" }, req.user!.id).catch(() => {});
    res.status(201).json(serializeShipment(shipment));
  } catch (err) {
    next(err);
  }
});

// The Warehouse sends the asked-for stock to Dispatch (its stock drops now)
fgRouter.post("/shipments/:id/send-to-dispatch", requireRole("STORE"), requireWarehouseSeat, async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "FROM_WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "REQUESTED") return res.status(409).json({ error: `This request is already ${shipment.status.toLowerCase()}.` });
    const held = warehouseHeldOf(shipment.productionBatch, true) + shipment.quantity; // its own request is counted in "asked for"
    if (shipment.quantity > held + EPS) return res.status(409).json({ error: `The Warehouse holds only ${round(held)} of this batch.` });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "SENT", sentById: req.user!.id, sentAt: new Date(), acceptedById: req.user!.id, acceptedAt: new Date() } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.sent_to_dispatch", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(["DISPATCH"], { title: `Warehouse sent finished goods: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - confirm once it reaches you.`, link: "/finished-goods" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// ...or refuses
const refuseSchema = z.object({ reason: z.string().trim().min(1, "Give a reason for refusing.").max(500) });
fgRouter.post("/shipments/:id/refuse-stock-request", requireRole("STORE"), requireWarehouseSeat, validateBody(refuseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "FROM_WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "REQUESTED") return res.status(409).json({ error: `This request is already ${shipment.status.toLowerCase()}.` });
    const { reason } = req.body as z.infer<typeof refuseSchema>;
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "REJECTED", acceptedById: req.user!.id, acceptedAt: new Date(), rejectedReason: reason } });
    const item = shipment.productionBatch.preProduction.purchaseOrderItem;
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.stock_request_refused", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    await notifyRoles(["DISPATCH"], { title: `Warehouse refused: ${item.productName}`, body: `${shipment.quantity} ${item.unit} - ${reason}`, link: "/finished-goods-dispatch" }, req.user!.id).catch(() => {});
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

// Dispatch confirms the stock reached it: from here it is Dispatch's to send to a customer
fgRouter.post("/shipments/:id/receive-from-warehouse", requireRole("DISPATCH"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const shipment = await loadShipment(req.params.id);
    if (!shipment || shipment.type !== "FROM_WAREHOUSE") return res.status(404).json({ error: "Request not found" });
    if (shipment.status !== "SENT") return res.status(409).json({ error: shipment.status === "RECEIVED" ? "Already received." : "The Warehouse has not sent this yet." });
    const updated = await prisma.fgShipment.update({ where: { id: shipment.id }, data: { status: "RECEIVED", receivedById: req.user!.id, receivedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "fg_shipment.received_from_warehouse", entityType: "ProductionBatch", entityId: shipment.productionBatchId, metadata: { shipmentId: shipment.id } });
    res.json(serializeShipment(updated));
  } catch (err) {
    next(err);
  }
});

fgRouter.get("/stock-requests", requireRole("STORE", "DISPATCH", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    await listWarehouseShipments(req, res, "FROM_WAREHOUSE");
  } catch (err) {
    next(err);
  }
});

fgRouter.get("/warehouse-requests", requireRole("STORE", "DISPATCH", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    return await listWarehouseShipments(req, res, "WAREHOUSE");
  } catch (err) {
    next(err);
  }
});
