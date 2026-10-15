import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { requireWarehouseSeat } from "./day-store-access";

/**
 * Rejected stock - what inward QC refused (a whole delivery, or the rejected part of an approved one). It is not in stock, but it
 * is still physically in the building until it goes back to the vendor or is destroyed. This is where that is recorded, so the
 * Quarantine never fills up with material nobody owns and Accounts can match a Debit Note to something that really left.
 *
 *   GET  /                           rejected deliveries still holding material (?all=1 also shows the cleared ones)
 *   POST /:receiptId/dispositions    record a return to the vendor / a destruction (Store)
 *   DELETE /dispositions/:id         undo a wrong entry (Store)
 */
export const rejectedStockRouter = Router();
rejectedStockRouter.use(requireAuth, requireWarehouseSeat);

const READ_ROLES = ["STORE", "QA_QC", "ACCOUNTS", "RND", "PPIC"] as const;
const EPS = 1e-9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The rejected part of a delivery: all of it when QC rejected the whole delivery, else the rejected quantity of an approved one. */
const rejectedPortionOf = (r: { receiptStatus: string | null; quantity: number; rejectedQty: number | null }) => (r.receiptStatus === "QC_REJECTED" ? r.quantity : (r.rejectedQty ?? 0));

const receiptSelect = {
  id: true,
  date: true,
  unit: true,
  quantity: true,
  rejectedQty: true,
  receiptStatus: true,
  qcNote: true,
  qcCheckedAt: true,
  vendorName: true,
  grnNo: true,
  batchNo: true,
  invoiceNo: true,
  item: { select: { id: true, name: true, category: true } },
  rejectedDispositions: { where: { deletedAt: null }, orderBy: { date: "asc" as const } },
  debitNotes: { select: { id: true, debitNoteNo: true, quantity: true } },
} satisfies Prisma.InventoryTransactionSelect;

rejectedStockRouter.get("/", requireRole(...READ_ROLES), async (req: AuthedRequest, res, next) => {
  try {
    const all = req.query.all === "1";
    const rows = await prisma.inventoryTransaction.findMany({
      where: { type: "RECEIVED", deletedAt: null, OR: [{ receiptStatus: "QC_REJECTED" }, { rejectedQty: { gt: 0 } }] },
      select: receiptSelect,
      orderBy: { qcCheckedAt: "desc" },
      take: 1000,
    });
    const out = rows
      .map((r) => {
        const rejected = rejectedPortionOf(r);
        const returned = r.rejectedDispositions.filter((d) => d.kind === "RETURNED_TO_VENDOR").reduce((s, d) => s + d.quantity, 0);
        const destroyed = r.rejectedDispositions.filter((d) => d.kind === "DESTROYED").reduce((s, d) => s + d.quantity, 0);
        return {
          id: r.id,
          itemName: r.item.name,
          category: r.item.category,
          vendorName: r.vendorName,
          grnNo: r.grnNo,
          batchNo: r.batchNo,
          invoiceNo: r.invoiceNo,
          receivedOn: r.date,
          rejectedAt: r.qcCheckedAt,
          reason: r.qcNote,
          unit: r.unit,
          deliveredQty: r.quantity,
          rejectedQty: round3(rejected),
          returnedQty: round3(returned),
          destroyedQty: round3(destroyed),
          remainingQty: round3(Math.max(0, rejected - returned - destroyed)),
          debitNoted: r.debitNotes.length > 0,
          dispositions: r.rejectedDispositions.map((d) => ({ id: d.id, kind: d.kind, quantity: d.quantity, date: d.date, challanNo: d.challanNo, vehicleNo: d.vehicleNo, note: d.note })),
        };
      })
      .filter((r) => r.rejectedQty > EPS && (all || r.remainingQty > EPS));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  kind: z.enum(["RETURNED_TO_VENDOR", "DESTROYED"]),
  quantity: z.coerce.number().positive(),
  date: z.coerce.date().optional(),
  challanNo: z.string().trim().max(120).optional(),
  vehicleNo: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

rejectedStockRouter.post("/:receiptId/dispositions", requireRole("STORE"), validateBody(dispositionSchema), async (req: AuthedRequest<{ receiptId: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof dispositionSchema>;
    if (input.kind === "RETURNED_TO_VENDOR" && !input.challanNo) return res.status(400).json({ error: "Enter the return challan number." });

    const created = await runSerializable(async (tx) => {
      const receipt = await tx.inventoryTransaction.findFirst({ where: { id: req.params.receiptId, type: "RECEIVED", deletedAt: null }, select: { ...receiptSelect, item: { select: { name: true } } } });
      if (!receipt) throw new RouteError(404, "Delivery not found");
      const rejected = rejectedPortionOf(receipt);
      if (rejected <= EPS) throw new RouteError(400, "Nothing was rejected on this delivery.");
      const done = receipt.rejectedDispositions.reduce((s, d) => s + d.quantity, 0);
      const remaining = rejected - done;
      if (input.quantity > remaining + EPS) throw new RouteError(409, `Only ${round3(remaining)} ${receipt.unit} of the rejected stock is still here - can't record ${input.quantity}.`);
      const row = await tx.rejectedDisposition.create({
        data: { receiptId: receipt.id, kind: input.kind, quantity: input.quantity, unit: receipt.unit, date: input.date ?? new Date(), challanNo: input.challanNo, vehicleNo: input.vehicleNo, note: input.note, createdById: req.user!.id },
      });
      return { row, itemName: receipt.item.name, vendorName: receipt.vendorName, unit: receipt.unit };
    });

    await recordAudit({ actorId: req.user!.id, action: input.kind === "RETURNED_TO_VENDOR" ? "inventory.rejected_returned_to_vendor" : "inventory.rejected_destroyed", entityType: "InventoryTransaction", entityId: req.params.receiptId, metadata: { quantity: input.quantity, challanNo: input.challanNo } });
    if (input.kind === "RETURNED_TO_VENDOR") {
      await notifyRoles(["ACCOUNTS"], { title: `${created.itemName} returned to ${created.vendorName ?? "the vendor"}`, body: `${input.quantity} ${created.unit}, challan ${input.challanNo} - match it to the Debit Note.`, link: "/inventory" }, req.user!.id).catch((err) =>
        req.log?.error({ err }, "notify failed: rejected_returned"),
      );
    }
    res.status(201).json(created.row);
  } catch (err) {
    next(err);
  }
});

rejectedStockRouter.delete("/dispositions/:id", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const row = await prisma.rejectedDisposition.findUnique({ where: { id: req.params.id } });
    if (!row || row.deletedAt) return res.status(404).json({ error: "Entry not found" });
    await prisma.rejectedDisposition.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "inventory.rejected_disposition_removed", entityType: "InventoryTransaction", entityId: row.receiptId, metadata: { quantity: row.quantity, kind: row.kind } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
