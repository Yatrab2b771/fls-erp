import type { Prisma } from "@prisma/client";

// Split out of purchase-orders.routes.ts so other modules (pending-materials.ts)
// can reuse the exact same "pending" definition without a circular import
// back into the route file.

export const poInclude = {
  customer: { select: { id: true, companyName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  items: {
    // deletedAt: null — a soft-deleted line item drops out of the PO the
    // instant it's removed, same as before, just recoverable now.
    where: { deletedAt: null },
    include: {
      // Lightweight summaries only — full plan detail (items, calculated
      // result) is fetched on-demand from the BOM/RM Costing pages
      // themselves; here we just need enough to render a status chip and
      // a link from the order/product view (the "Production Pipeline"
      // strip that ties all four modules together).
      bomPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      rmPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      // PPIC's own planning call — see PurchaseOrderItem.plannedPlantId's
      // own schema comment and PATCH /:id/items/:itemId/planned-plant.
      plannedPlant: { select: { id: true, name: true } },
      // Just enough to compute completion below (and to know whether
      // production has started at all, for the delete guard further
      // down) — not the run's full record, that's what GET
      // /api/pre-productions/:id is for. PreProduction is 1:1 with a PO
      // item now, so this is at most one row, not a list. productionBatches
      // covers the newer "a batch can dispatch on its own" path (see
      // computeCompletion below) alongside the older combinedLot-only one.
      preProduction: {
        select: {
          id: true,
          combinedLot: { select: { currentStageId: true, dispatchDate: true, dispatchedQty: true } },
          productionBatches: { select: { currentStageId: true, dispatchDate: true, dispatchedQty: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  // deletedAt: null — same reasoning as items above.
  documents: { where: { deletedAt: null }, select: { id: true, filename: true, mimeType: true, uploadedAt: true, uploadedById: true } },
} satisfies Prisma.PurchaseOrderInclude;

export type PoWithBatches = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

// A PO is "completed" once every line item's own ordered quantity has
// actually gone out the door — via EITHER path a PreProduction's
// material can now take: pooled into a CombinedLot that's reached
// DISPATCH_PLAN (the original "ship everything together" flow), or one
// or more of its own ProductionBatches independently reaching their OWN
// DISPATCH_PLAN (see schema.prisma's comment on ProductionBatch — a
// batch doesn't have to wait for its siblings any more). Both can
// contribute on the same item (some of a run's material combined, some
// shipped batch-by-batch) — this sums whichever actually reached
// Dispatch Plan on either side and compares the total against the item's
// own ordered quantity, so a partial dispatch alone never marks a PO
// "Completed"; only once the last bit of a product's quantity has
// shipped does it flip. Computed on read, never stored — same rule as
// every other derived number in this app. completionDate is the latest
// dispatchDate across every contributing lot/batch (the business-entered
// ship date at that stage, not a technical row-update timestamp), and
// daysTaken is the whole-day span from the PO's own orderDate (falling
// back to when it was entered, if BD never filled one in).
export function computeCompletion(po: PoWithBatches): { isCompleted: boolean; completionDate: string | null; daysTaken: number | null } {
  if (po.items.length === 0) return { isCompleted: false, completionDate: null, daysTaken: null };

  const round = (n: number) => Math.round(n * 1000) / 1000;

  const itemResults = po.items.map((item) => {
    const preProduction = item.preProduction;
    if (!preProduction) return { isDone: false, dispatchDates: [] as Date[] };

    let dispatchedQty = 0;
    const dispatchDates: Date[] = [];

    const lot = preProduction.combinedLot;
    if (lot?.currentStageId === "DISPATCH_PLAN") {
      dispatchedQty += lot.dispatchedQty ?? 0;
      if (lot.dispatchDate) dispatchDates.push(lot.dispatchDate);
    }
    for (const batch of preProduction.productionBatches) {
      if (batch.currentStageId === "DISPATCH_PLAN") {
        dispatchedQty += batch.dispatchedQty ?? 0;
        if (batch.dispatchDate) dispatchDates.push(batch.dispatchDate);
      }
    }

    return { isDone: round(dispatchedQty) >= round(item.quantity) - 1e-6, dispatchDates };
  });

  const isCompleted = itemResults.every((r) => r.isDone);
  if (!isCompleted) return { isCompleted: false, completionDate: null, daysTaken: null };

  const allDispatchDates = itemResults.flatMap((r) => r.dispatchDates);
  if (allDispatchDates.length === 0) return { isCompleted: true, completionDate: null, daysTaken: null }; // reached Dispatch Plan everywhere, but no ship date was ever filled in to measure from

  const completionDate = new Date(Math.max(...allDispatchDates.map((d) => d.getTime())));
  const startDate = po.orderDate ?? po.createdAt;
  const daysTaken = Math.round((completionDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  return { isCompleted: true, completionDate: completionDate.toISOString(), daysTaken };
}
