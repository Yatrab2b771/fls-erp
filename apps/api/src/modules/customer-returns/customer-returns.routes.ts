import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { requireWarehouseSeat } from "../inventory/day-store-access";

/**
 * Customer returns: finished goods a customer sent back. They reach the Warehouse.
 *
 *   Warehouse   POST /                    records the return (kept on a QA hold - not stock); GET /returnable lists what can be returned
 *   QA          POST /:id/qa              PASS (Dispatch decides next), REWORK (Production reprocesses it) or SCRAP
 *   Production  POST /:id/rework-done     says what came out of the rework; QA checks it again (pass or scrap)
 *   Dispatch    POST /:id/dispatch        for what QA passed: STORE it in the Warehouse's finished-goods stock, or REDISPATCH (back in Dispatch's
 *                                         stock of the batch, to send to the customer again through the normal shipment)
 *   Accounts    POST /:id/credit-note     the credit note for the return (one per return)
 *   GET /       the list (?status= many, ?noCreditNote=1);  GET /summary  the counts for the dashboard tiles
 *
 * What the customer holds (for a product's completion) is shipped less returned; Dispatch's stock of the batch gets back what QA passed
 * (see fg.routes.ts shippedOf). See CustomerReturn in schema.prisma.
 */
export const customerReturnsRouter = Router();
customerReturnsRouter.use(requireAuth);

const READERS = ["STORE", "QA_QC", "PRODUCTION", "DISPATCH", "ACCOUNTS", "PPIC"] as const;
const EPS = 1e-6;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const STATUSES = ["WITH_QA", "IN_REWORK", "AWAITING_DISPATCH", "STORED", "TO_BE_RESENT", "SCRAPPED"] as const;
const OPEN = ["WITH_QA", "IN_REWORK", "AWAITING_DISPATCH"] as const;

const returnInclude = {
  creditNote: true,
  reworks: { select: { id: true, reworkNo: true, status: true, quantity: true, outputQty: true }, orderBy: { createdAt: "asc" } },
  productionBatch: {
    select: {
      id: true,
      batchNo: true,
      fgShipments: { where: { deletedAt: null, type: "CUSTOMER", status: "DISPATCHED" }, select: { quantity: true, invoiceAmount: true } },
      preProduction: { select: { plant: { select: { name: true } }, purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } } } },
    },
  },
} satisfies Prisma.CustomerReturnInclude;
type ReturnRow = Prisma.CustomerReturnGetPayload<{ include: typeof returnInclude }>;

/** What the credit might be: the batch's invoiced value per unit shipped, times the quantity that came back (Accounts can change it). */
function suggestedAmount(r: ReturnRow): number | null {
  const shipments = r.productionBatch.fgShipments.filter((s) => s.invoiceAmount != null);
  const qty = shipments.reduce((sum, s) => sum + s.quantity, 0);
  if (qty <= EPS) return null;
  const value = shipments.reduce((sum, s) => sum + (s.invoiceAmount ?? 0), 0);
  return Math.round((value / qty) * r.quantity * 100) / 100;
}

function serialize(r: ReturnRow) {
  const batch = r.productionBatch;
  const item = batch.preProduction.purchaseOrderItem;
  return {
    id: r.id,
    status: r.status,
    batchId: batch.id,
    batchNo: batch.batchNo,
    poId: item.purchaseOrder.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    productName: item.productName,
    plantName: batch.preProduction.plant?.name ?? null,
    unit: r.unit,
    quantity: r.quantity,
    returnedAt: r.returnedAt,
    reason: r.reason,
    condition: r.condition,
    receivedAt: r.createdAt,
    qa: r.qaDecision ? { decision: r.qaDecision, note: r.qaNote, at: r.qaDecidedAt, passedQty: r.passedQty, scrapQty: r.scrapQty } : null,
    rework: r.reworkDoneAt ? { note: r.reworkNote, reworkedQty: r.reworkedQty, doneAt: r.reworkDoneAt } : null,
    /** The reworks sent to New Plan for this return (each with its sub-number), and how much of it is not in New Plan yet. */
    reworks: r.reworks.map((w) => ({ id: w.id, reworkNo: w.reworkNo, status: w.status, quantity: w.quantity, outputQty: w.outputQty })),
    reworkLeft: round3(Math.max(0, r.quantity - r.reworks.reduce((s, w) => s + w.quantity, 0))),
    /** Whether the goods have been through rework: QA's second look can only pass or scrap them. */
    reworked: !!r.reworkDoneAt,
    dispatch: r.dispatchChoice ? { choice: r.dispatchChoice, note: r.dispatchNote, at: r.dispatchDecidedAt } : null,
    creditNote: r.creditNote ? { id: r.creditNote.id, no: r.creditNote.creditNoteNo, date: r.creditNote.date, amount: r.creditNote.amount, note: r.creditNote.note } : null,
    suggestedAmount: suggestedAmount(r),
  };
}

async function loadReturn(id: string): Promise<ReturnRow> {
  const row = await prisma.customerReturn.findUnique({ where: { id }, include: returnInclude });
  if (!row) throw new RouteError(404, "Return not found");
  return row;
}

const label = (r: ReturnRow) => {
  const item = r.productionBatch.preProduction.purchaseOrderItem;
  return `${item.productName} (${item.purchaseOrder.poNumber ?? "PO"}${r.productionBatch.batchNo ? `, batch ${r.productionBatch.batchNo}` : ""})`;
};

// ---------------------------------------------------------------------------------------------------------------- lists

customerReturnsRouter.get("/", requireRole(...READERS), async (req, res, next) => {
  try {
    const raw = req.query.status;
    const statuses = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is (typeof STATUSES)[number] => typeof v === "string" && (STATUSES as readonly string[]).includes(v));
    const rows = await prisma.customerReturn.findMany({
      where: { ...(statuses.length ? { status: { in: statuses } } : {}), ...(req.query.noCreditNote === "1" ? { creditNote: { is: null } } : {}) },
      include: returnInclude,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

/** The counts behind the dashboard tiles (each department's own). */
customerReturnsRouter.get("/summary", requireRole(...READERS), async (_req, res, next) => {
  try {
    const [byStatus, noCreditNote] = await Promise.all([prisma.customerReturn.groupBy({ by: ["status"], _count: { _all: true } }), prisma.customerReturn.count({ where: { creditNote: { is: null } } })]);
    const n = (s: (typeof STATUSES)[number]) => byStatus.find((g) => g.status === s)?._count._all ?? 0;
    res.json({ withQa: n("WITH_QA"), inRework: n("IN_REWORK"), awaitingDispatch: n("AWAITING_DISPATCH"), open: OPEN.reduce((sum, s) => sum + n(s), 0), noCreditNote });
  } catch (err) {
    next(err);
  }
});

/** What the Warehouse can record a return against: batches with goods shipped to a customer that have not all been returned. */
customerReturnsRouter.get("/returnable", requireRole("STORE"), requireWarehouseSeat, async (_req, res, next) => {
  try {
    const batches = await prisma.productionBatch.findMany({
      where: { fgShipments: { some: { type: "CUSTOMER", status: "DISPATCHED", deletedAt: null } } },
      select: {
        id: true,
        batchNo: true,
        fgShipments: { where: { deletedAt: null, type: "CUSTOMER", status: "DISPATCHED" }, select: { quantity: true, invoiceNo: true, dispatchDate: true } },
        customerReturns: { select: { quantity: true } },
        preProduction: { select: { purchaseOrderItem: { select: { productName: true, unit: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } } } },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    res.json(
      batches
        .map((b) => {
          const item = b.preProduction.purchaseOrderItem;
          const shipped = b.fgShipments.reduce((s, x) => s + x.quantity, 0);
          const returned = b.customerReturns.reduce((s, x) => s + x.quantity, 0);
          return {
            batchId: b.id,
            batchNo: b.batchNo,
            poNumber: item.purchaseOrder.poNumber,
            customerName: item.purchaseOrder.customer.companyName,
            productName: item.productName,
            unit: item.unit,
            withCustomerQty: round3(shipped - returned),
            invoiceNos: [...new Set(b.fgShipments.map((s) => s.invoiceNo).filter((v): v is string => !!v))],
          };
        })
        .filter((r) => r.withCustomerQty > EPS),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Warehouse records the return

const recordSchema = z.object({
  batchId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  returnedAt: z.coerce.date().optional(),
  reason: z.string().trim().min(3, "Write why the customer sent it back.").max(500),
  condition: z.string().trim().max(500).optional(),
});

customerReturnsRouter.post("/", requireRole("STORE"), requireWarehouseSeat, validateBody(recordSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof recordSchema>;
    const batch = await prisma.productionBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        fgShipments: { where: { deletedAt: null, type: "CUSTOMER", status: "DISPATCHED" }, select: { quantity: true } },
        customerReturns: { select: { quantity: true } },
        preProduction: { select: { purchaseOrderItem: { select: { unit: true } } } },
      },
    });
    if (!batch) throw new RouteError(404, "Batch not found");
    const withCustomer = batch.fgShipments.reduce((s, x) => s + x.quantity, 0) - batch.customerReturns.reduce((s, x) => s + x.quantity, 0);
    if (withCustomer <= EPS) throw new RouteError(409, "Nothing of this batch is with a customer.");
    if (input.quantity > withCustomer + EPS) throw new RouteError(409, `Only ${round3(withCustomer)} of this batch is with the customer - can't take back ${input.quantity}.`);

    const created = await prisma.customerReturn.create({
      data: { productionBatchId: batch.id, quantity: input.quantity, unit: batch.preProduction.purchaseOrderItem.unit, returnedAt: input.returnedAt ?? new Date(), reason: input.reason, condition: input.condition || null, receivedById: req.user!.id },
      include: returnInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "customer_return.recorded", entityType: "ProductionBatch", entityId: batch.id, metadata: { returnId: created.id, quantity: input.quantity, reason: input.reason } });
    const text = `${input.quantity} ${created.unit} of ${label(created)} - ${input.reason}`;
    await notifyRoles(["QA_QC"], { title: "A customer return waits for QA", body: text, link: "/returned-goods" }, req.user!.id).catch(() => undefined);
    await notifyRoles(["ACCOUNTS"], { title: "A customer returned goods: credit note", body: text, link: "/credit-notes" }, req.user!.id).catch(() => undefined);
    await notifyRoles(["DISPATCH"], { title: "A customer returned goods", body: text, link: "/returned-goods-dispatch" }, req.user!.id).catch(() => undefined);
    res.status(201).json(serialize(created));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- QA decides

const qaSchema = z.object({
  decision: z.enum(["PASS", "REWORK", "SCRAP"]),
  /** For PASS: how much is passed (the rest is scrapped). Default: all of it. */
  passedQty: z.coerce.number().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

customerReturnsRouter.post("/:id/qa", requireRole("QA_QC"), validateBody(qaSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof qaSchema>;
    const row = await loadReturn(req.params.id);
    if (row.status !== "WITH_QA") throw new RouteError(409, "This return is not waiting for QA.");
    const reworked = !!row.reworkDoneAt;
    if (reworked && input.decision === "REWORK") throw new RouteError(409, "It has already been through rework: pass it or scrap it.");
    if (input.decision !== "PASS" && (input.note ?? "").length < 3) throw new RouteError(400, input.decision === "REWORK" ? "Say what has to be reworked." : "Say why it is scrapped.");

    // What QA can pass: all of the return, or after rework only what came out of it
    const available = reworked ? (row.reworkedQty ?? 0) : row.quantity;
    let data: Prisma.CustomerReturnUpdateInput;
    if (input.decision === "PASS") {
      const passed = round3(input.passedQty ?? available);
      if (passed <= EPS || passed > available + EPS) throw new RouteError(400, `Pass a quantity up to ${round3(available)} ${row.unit}.`);
      data = { status: "AWAITING_DISPATCH", qaDecision: "PASS", passedQty: passed, scrapQty: round3(row.quantity - passed) };
    } else if (input.decision === "REWORK") {
      data = { status: "IN_REWORK", qaDecision: "REWORK", passedQty: null, scrapQty: 0 };
    } else {
      data = { status: "SCRAPPED", qaDecision: "SCRAP", passedQty: 0, scrapQty: row.quantity };
    }
    const updated = await prisma.customerReturn.update({ where: { id: row.id }, data: { ...data, qaNote: input.note || null, qaDecidedAt: new Date(), qaDecidedById: req.user!.id }, include: returnInclude });
    await recordAudit({ actorId: req.user!.id, action: `customer_return.qa_${input.decision.toLowerCase()}`, entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { returnId: row.id, passedQty: updated.passedQty, note: input.note } });
    if (input.decision === "PASS") await notifyRoles(["DISPATCH"], { title: "QA passed a returned batch: store it or send it again", body: `${updated.passedQty} ${row.unit} of ${label(updated)}`, link: "/returned-goods-dispatch" }, req.user!.id).catch(() => undefined);
    if (input.decision === "REWORK") await notifyRoles(["PRODUCTION"], { title: "A returned batch needs rework", body: `${row.quantity} ${row.unit} of ${label(updated)} - ${input.note}`, link: "/rework" }, req.user!.id).catch(() => undefined);
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Production's rework

const reworkSchema = z.object({
  /** What came out of the rework and can go back to QA (the rest was lost). */
  reworkedQty: z.coerce.number().nonnegative(),
  note: z.string().trim().max(500).optional(),
});

customerReturnsRouter.post("/:id/rework-done", requireRole("PRODUCTION"), validateBody(reworkSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof reworkSchema>;
    const row = await loadReturn(req.params.id);
    if (row.status !== "IN_REWORK") throw new RouteError(409, "This return is not in rework.");
    if (row.reworks.length > 0) throw new RouteError(409, "This return is being reworked through New Plan: complete its rework there.");
    if (input.reworkedQty > row.quantity + EPS) throw new RouteError(400, `At most ${row.quantity} ${row.unit} can come out of the rework.`);
    const updated = await prisma.customerReturn.update({
      where: { id: row.id },
      data: { status: "WITH_QA", reworkedQty: round3(input.reworkedQty), reworkNote: input.note || null, reworkDoneAt: new Date(), reworkDoneById: req.user!.id },
      include: returnInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "customer_return.rework_done", entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { returnId: row.id, reworkedQty: input.reworkedQty } });
    await notifyRoles(["QA_QC"], { title: "Reworked goods wait for QA", body: `${round3(input.reworkedQty)} of ${row.quantity} ${row.unit} of ${label(updated)}`, link: "/returned-goods" }, req.user!.id).catch(() => undefined);
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Dispatch chooses

const dispatchSchema = z.object({ choice: z.enum(["STORE", "REDISPATCH"]), note: z.string().trim().max(500).optional() });

customerReturnsRouter.post("/:id/dispatch", requireRole("DISPATCH"), validateBody(dispatchSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof dispatchSchema>;
    const row = await loadReturn(req.params.id);
    if (row.status !== "AWAITING_DISPATCH") throw new RouteError(409, "QA has not passed this return, or it has already been dealt with.");
    const passed = row.passedQty ?? 0;
    const updated = await prisma.$transaction(async (tx) => {
      if (input.choice === "STORE") {
        // The goods are already in the Warehouse: they join its finished-goods stock (the same record as a transfer from Dispatch that was received)
        await tx.fgShipment.create({
          data: { productionBatchId: row.productionBatchId, type: "WAREHOUSE", status: "RECEIVED", quantity: passed, note: "Customer return passed by QA", requestedById: req.user!.id, sentById: req.user!.id, sentAt: new Date(), receivedById: req.user!.id, receivedAt: new Date() },
        });
      }
      return tx.customerReturn.update({
        where: { id: row.id },
        data: { status: input.choice === "STORE" ? "STORED" : "TO_BE_RESENT", dispatchChoice: input.choice, dispatchNote: input.note || null, dispatchDecidedAt: new Date(), dispatchDecidedById: req.user!.id },
        include: returnInclude,
      });
    });
    await recordAudit({ actorId: req.user!.id, action: input.choice === "STORE" ? "customer_return.stored" : "customer_return.to_be_resent", entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { returnId: row.id, quantity: passed } });
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Accounts' credit note

const creditNoteSchema = z.object({
  creditNoteNo: z.string().trim().min(1, "Enter the credit note number.").max(120),
  date: z.coerce.date().optional(),
  amount: z.coerce.number().nonnegative().optional(),
  note: z.string().trim().max(500).optional(),
});

customerReturnsRouter.post("/:id/credit-note", requireRole("ACCOUNTS"), validateBody(creditNoteSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof creditNoteSchema>;
    const row = await loadReturn(req.params.id);
    if (row.creditNote) throw new RouteError(409, "A credit note has already been made for this return.");
    await prisma.creditNote.create({ data: { customerReturnId: row.id, creditNoteNo: input.creditNoteNo, date: input.date ?? new Date(), amount: input.amount ?? suggestedAmount(row), note: input.note || null, createdById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "customer_return.credit_note", entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { returnId: row.id, creditNoteNo: input.creditNoteNo, amount: input.amount } });
    res.status(201).json(serialize(await loadReturn(row.id)));
  } catch (err) {
    next(err);
  }
});
