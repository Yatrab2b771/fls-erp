import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess } from "../inventory/day-store-access";
import { plantFreeQty } from "../plant-consumption/plant-position";

/**
 * Reworks of goods a customer returned. QA chose Rework for a return; Production sends it to New Plan, where it shows with a "Rework" tag and a
 * sub-number of the original batch (FLS-26-0006-R1, -R2 ...). It is a small job with a sheet like a batch's:
 *
 *   POST  /                      send (part of) a return to New Plan: makes the rework and its number
 *   GET   /                      the reworks (New Plan and the Rework page)
 *   PATCH /:id                   the sheet: shift, manpower, start and end date-time
 *   POST  /:id/materials         material used (booked against the Plant's free stock; DELETE .../materials/:lineId takes it back)
 *   POST  /:id/complete          end time and how much came out; when the reworks of the return are all done it goes back to QA
 *   POST  /for-return/:id/send-to-qa   send back what is done when part of the return will not be reworked
 *   DELETE /:id                  take a rework that has not started out of New Plan
 *
 * A rework is NOT part of the product's order (planned / made / shortfall): the goods were counted when they were first made.
 */
export const reworksRouter = Router();
reworksRouter.use(requireAuth);

const READERS = ["PRODUCTION", "QA_QC", "PPIC", "STORE"] as const;
const EPS = 1e-6;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const reworkInclude = {
  consumptions: { include: { item: { select: { id: true, name: true, category: true } } }, orderBy: { createdAt: "asc" } },
  customerReturn: { select: { id: true, status: true, quantity: true, reason: true, qaNote: true } },
  productionBatch: {
    select: {
      id: true,
      batchNo: true,
      preProduction: {
        select: {
          id: true,
          plantId: true,
          plant: { select: { name: true } },
          purchaseOrderItem: { select: { productName: true, productCategory: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } },
        },
      },
    },
  },
} satisfies Prisma.ReworkInclude;
type ReworkRow = Prisma.ReworkGetPayload<{ include: typeof reworkInclude }>;

function serialize(r: ReworkRow) {
  const run = r.productionBatch.preProduction;
  const item = run.purchaseOrderItem;
  return {
    id: r.id,
    reworkNo: r.reworkNo,
    status: r.status as "PLANNED" | "IN_PROGRESS" | "COMPLETED",
    quantity: r.quantity,
    unit: r.unit,
    shift: r.shift,
    manpowerCount: r.manpowerCount,
    startAt: r.startAt,
    endAt: r.endAt,
    outputQty: r.outputQty,
    note: r.note,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    returnId: r.customerReturnId,
    returnStatus: r.customerReturn.status,
    returnQty: r.customerReturn.quantity,
    returnReason: r.customerReturn.reason,
    qaNote: r.customerReturn.qaNote,
    batchId: r.productionBatch.id,
    batchNo: r.productionBatch.batchNo,
    poId: item.purchaseOrder.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    productName: item.productName,
    productCategory: item.productCategory,
    plantId: run.plantId,
    plantName: run.plant?.name ?? null,
    materials: r.consumptions.map((c) => ({ id: c.id, itemId: c.itemId, itemName: c.item.name, category: c.item.category, quantity: c.quantity, unit: c.unit })),
  };
}

async function load(id: string): Promise<ReworkRow> {
  const row = await prisma.rework.findUnique({ where: { id }, include: reworkInclude });
  if (!row) throw new RouteError(404, "Rework not found");
  return row;
}

/** The Plant's own login only works on its own Plant's reworks. */
async function assertAccess(req: AuthedRequest, row: ReworkRow) {
  await assertPlantAccess(req.user!.id, req.user!.roles, row.productionBatch.preProduction.plantId);
}

reworksRouter.get("/", requireRole(...READERS), async (_req, res, next) => {
  try {
    const rows = await prisma.rework.findMany({ include: reworkInclude, orderBy: { createdAt: "desc" }, take: 300 });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({ customerReturnId: z.string().uuid(), quantity: z.coerce.number().positive().optional() });

/** Production sends (part of) a return QA wants reworked to New Plan: the rework gets its number (original batch + -R1, -R2 ...). */
reworksRouter.post("/", requireRole("PRODUCTION"), validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof createSchema>;
    const ret = await prisma.customerReturn.findUnique({
      where: { id: input.customerReturnId },
      select: { id: true, status: true, quantity: true, unit: true, productionBatchId: true, productionBatch: { select: { batchNo: true, preProduction: { select: { plantId: true } } } }, reworks: { select: { quantity: true } } },
    });
    if (!ret) throw new RouteError(404, "Return not found");
    await assertPlantAccess(req.user!.id, req.user!.roles, ret.productionBatch.preProduction.plantId);
    if (ret.status !== "IN_REWORK") throw new RouteError(409, "QA has not sent this return for rework (or it has already gone back to QA).");
    const left = round3(ret.quantity - ret.reworks.reduce((s, r) => s + r.quantity, 0));
    if (left <= EPS) throw new RouteError(409, "All of this return is already in New Plan.");
    const quantity = input.quantity ?? left;
    if (quantity > left + EPS) throw new RouteError(409, `Only ${left} ${ret.unit} of this return is left to send to New Plan.`);

    const base = ret.productionBatch.batchNo ?? `BATCH-${ret.productionBatchId.slice(0, 6)}`;
    const row = await prisma.$transaction(async (tx) => {
      let seq = (await tx.rework.count({ where: { productionBatchId: ret.productionBatchId } })) + 1;
      while (await tx.rework.findUnique({ where: { reworkNo: `${base}-R${seq}` }, select: { id: true } })) seq += 1;
      return tx.rework.create({ data: { reworkNo: `${base}-R${seq}`, seq, customerReturnId: ret.id, productionBatchId: ret.productionBatchId, quantity: round3(quantity), unit: ret.unit, createdById: req.user!.id }, include: reworkInclude });
    });
    await recordAudit({ actorId: req.user!.id, action: "rework.sent_to_new_plan", entityType: "ProductionBatch", entityId: ret.productionBatchId, metadata: { reworkId: row.id, reworkNo: row.reworkNo, quantity: row.quantity } });
    res.status(201).json(serialize(row));
  } catch (err) {
    next(err);
  }
});

const sheetSchema = z
  .object({
    shift: z.enum(["Day", "Night"]).optional(),
    manpowerCount: z.coerce.number().int().positive().optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
  })
  .refine((d) => !d.startAt || !d.endAt || d.endAt.getTime() >= d.startAt.getTime(), { message: "End time can't be before the start time.", path: ["endAt"] });

reworksRouter.patch("/:id", requireRole("PRODUCTION"), validateBody(sheetSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof sheetSchema>;
    const row = await load(req.params.id);
    await assertAccess(req, row);
    if (row.status === "COMPLETED") throw new RouteError(409, "This rework is completed.");
    const startAt = input.startAt ?? row.startAt;
    const endAt = input.endAt ?? row.endAt;
    if (startAt && endAt && endAt.getTime() < startAt.getTime()) throw new RouteError(400, "End time can't be before the start time.");
    const shift = input.shift ?? row.shift;
    const manpowerCount = input.manpowerCount ?? row.manpowerCount;
    const updated = await prisma.rework.update({
      where: { id: row.id },
      data: { shift, manpowerCount, startAt, endAt, status: shift && manpowerCount && startAt ? "IN_PROGRESS" : row.status },
      include: reworkInclude,
    });
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

const materialSchema = z.object({ itemId: z.string().uuid(), quantity: z.coerce.number().positive() });

/** Material used in the rework comes out of the Plant's FREE stock (what no batch has been given). Short: ask for extra material. */
reworksRouter.post("/:id/materials", requireRole("PRODUCTION"), validateBody(materialSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof materialSchema>;
    const row = await load(req.params.id);
    await assertAccess(req, row);
    if (row.status === "COMPLETED") throw new RouteError(409, "This rework is completed.");
    const run = row.productionBatch.preProduction;
    if (!run.plantId) throw new RouteError(409, "This rework has no Plant to take material from.");
    const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true, unit: true } });
    if (!item) throw new RouteError(400, "Unknown inventory item");
    const free = (await plantFreeQty(run.plantId, [item.id])).get(item.id) ?? 0;
    if (input.quantity > free + EPS) {
      throw new RouteError(409, `Only ${round3(Math.max(0, free))} ${item.unit ?? ""} of ${item.name} is free at the Plant. Request extra material from the Store (it goes on to the Warehouse and PPIC only if they are short too).`);
    }
    await prisma.batchMaterialConsumption.create({ data: { preProductionId: run.id, itemId: item.id, quantity: input.quantity, unit: item.unit ?? "Kg", purpose: "PRODUCTION", createdById: req.user!.id, reworkId: row.id } });
    if (row.status === "PLANNED" && row.shift && row.manpowerCount && row.startAt) await prisma.rework.update({ where: { id: row.id }, data: { status: "IN_PROGRESS" } });
    res.status(201).json(serialize(await load(row.id)));
  } catch (err) {
    next(err);
  }
});

reworksRouter.delete("/:id/materials/:lineId", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string; lineId: string }>, res, next) => {
  try {
    const row = await load(req.params.id);
    await assertAccess(req, row);
    if (row.status === "COMPLETED") throw new RouteError(409, "This rework is completed.");
    const line = row.consumptions.find((c) => c.id === req.params.lineId);
    if (!line) throw new RouteError(404, "Material line not found");
    await prisma.batchMaterialConsumption.delete({ where: { id: line.id } }); // the quantity is back in the Plant's stock
    res.json(serialize(await load(row.id)));
  } catch (err) {
    next(err);
  }
});

/** When every rework of a return is done and together they cover all of it (or Production says the rest will not be reworked), the return goes back to QA. */
async function returnToQa(returnId: string, actorId: string, onlyIfAllCovered: boolean): Promise<boolean> {
  const ret = await prisma.customerReturn.findUnique({ where: { id: returnId }, include: { reworks: true, productionBatch: { select: { batchNo: true, preProduction: { select: { purchaseOrderItem: { select: { productName: true } } } } } } } });
  if (!ret || ret.status !== "IN_REWORK") return false;
  if (ret.reworks.length === 0 || ret.reworks.some((r) => r.status !== "COMPLETED")) return false;
  const planned = ret.reworks.reduce((s, r) => s + r.quantity, 0);
  if (onlyIfAllCovered && planned < ret.quantity - EPS) return false;
  const out = round3(ret.reworks.reduce((s, r) => s + (r.outputQty ?? 0), 0));
  await prisma.customerReturn.update({
    where: { id: ret.id },
    data: { status: "WITH_QA", reworkedQty: out, reworkNote: ret.reworks.map((r) => `${r.reworkNo}: ${r.outputQty ?? 0} of ${r.quantity} ${r.unit} came out`).join("; "), reworkDoneAt: new Date(), reworkDoneById: actorId },
  });
  await recordAudit({ actorId, action: "customer_return.rework_done", entityType: "ProductionBatch", entityId: ret.productionBatchId, metadata: { returnId: ret.id, reworkedQty: out } });
  await notifyRoles(["QA_QC"], { title: "Reworked goods wait for QA", body: `${out} of ${ret.quantity} ${ret.unit} of ${ret.productionBatch.preProduction.purchaseOrderItem.productName}${ret.productionBatch.batchNo ? ` (batch ${ret.productionBatch.batchNo})` : ""}`, link: "/returned-goods" }, actorId).catch(() => undefined);
  return true;
}

const completeSchema = z.object({ endAt: z.coerce.date(), outputQty: z.coerce.number().nonnegative(), note: z.string().trim().max(500).optional() });

reworksRouter.post("/:id/complete", requireRole("PRODUCTION"), validateBody(completeSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof completeSchema>;
    const row = await load(req.params.id);
    await assertAccess(req, row);
    if (row.status === "COMPLETED") throw new RouteError(409, "Already completed.");
    if (!row.shift || !row.manpowerCount || !row.startAt) throw new RouteError(409, "Fill the start fields first: shift, manpower and the start date and time.");
    if (input.endAt.getTime() < row.startAt.getTime()) throw new RouteError(400, "End time can't be before the start time.");
    if (input.outputQty > row.quantity + EPS) throw new RouteError(400, `At most ${row.quantity} ${row.unit} can come out of this rework.`);
    await prisma.rework.update({ where: { id: row.id }, data: { status: "COMPLETED", endAt: input.endAt, outputQty: round3(input.outputQty), note: input.note || row.note, completedAt: new Date(), completedById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "rework.completed", entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { reworkId: row.id, reworkNo: row.reworkNo, outputQty: input.outputQty } });
    const sentToQa = await returnToQa(row.customerReturnId, req.user!.id, true);
    res.json({ ...serialize(await load(row.id)), sentToQa });
  } catch (err) {
    next(err);
  }
});

/** Part of a return will not be reworked: send back what is done (the rest counts as not recovered). Only when no rework of it is still open. */
reworksRouter.post("/for-return/:id/send-to-qa", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const ret = await prisma.customerReturn.findUnique({ where: { id: req.params.id }, select: { id: true, reworks: { select: { status: true } }, productionBatch: { select: { preProduction: { select: { plantId: true } } } } } });
    if (!ret) throw new RouteError(404, "Return not found");
    await assertPlantAccess(req.user!.id, req.user!.roles, ret.productionBatch.preProduction.plantId);
    if (ret.reworks.length === 0) throw new RouteError(409, "Nothing has been reworked yet.");
    if (ret.reworks.some((r) => r.status !== "COMPLETED")) throw new RouteError(409, "A rework of this return is still open. Complete it (or take it out of New Plan) first.");
    if (!(await returnToQa(ret.id, req.user!.id, false))) throw new RouteError(409, "This return is not in rework.");
    res.json({ sentToQa: true });
  } catch (err) {
    next(err);
  }
});

/** A rework that has not started can be taken out of New Plan (its quantity is free to send again). */
reworksRouter.delete("/:id", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const row = await load(req.params.id);
    await assertAccess(req, row);
    if (row.status !== "PLANNED" || row.consumptions.length > 0) throw new RouteError(409, "Only a rework that has not started can be taken out.");
    await prisma.rework.delete({ where: { id: row.id } });
    await recordAudit({ actorId: req.user!.id, action: "rework.removed", entityType: "ProductionBatch", entityId: row.productionBatchId, metadata: { reworkNo: row.reworkNo } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
