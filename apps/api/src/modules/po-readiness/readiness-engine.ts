import { prisma } from "../../common/lib/prisma";
import { getTotalAvailableByItemId } from "../inventory/stock";
import type { Prisma } from "@prisma/client";

// --- Shared readiness computation — one PO is "ready" once every one of
// its requirement rows has enough live stock. Computed on read, never
// stored, same rule as every other derived number in this app. Split out
// of po-readiness.routes.ts (same "engine separate from routes" split as
// packaging-bom/bom-engine.ts) so other modules — the Batch pipeline's
// creation gate — can reuse it without importing a route file. ---

const poSummaryInclude = {
  customer: { select: { id: true, companyName: true } },
} satisfies Prisma.PurchaseOrderInclude;

export interface PoReadinessRow {
  purchaseOrder: { id: string; poNumber: string | null; status: string; customer: { id: string; companyName: string } };
  items: { itemId: string; itemName: string; category: string; requiredQty: number; unit: string; onHand: number; covered: boolean }[];
  totalItems: number;
  readyItems: number;
  isReady: boolean;
}

// `filterPoIds`, when given, only trims which POs come back in the
// *result* — the allocation itself always runs over every PO in the
// system that has requirements. Two POs both needing 10 Kg of an item
// the Warehouse only has 10 Kg of can't both be "covered" against the
// same physical units; whichever requirement row was recorded first
// (createdAt — the confirmed priority rule: first requirement entered,
// first served, an upload/manual-add's timestamp survives a later
// correction since upsert only touches requiredQty/unit/category) gets
// first claim, and it decrements a running per-item balance that every
// later-recorded requirement for that same item then checks against.
// Running this allocation over only a filtered subset (e.g. just one
// PO) would silently ignore other POs' earlier claims on the same item
// and over-report coverage — same bug this whole thing exists to fix,
// just reintroduced at the query level instead of the math level.
export async function computeReadiness(filterPoIds?: string[]): Promise<PoReadinessRow[]> {
  const requirements = await prisma.poMaterialRequirement.findMany({
    where: { deletedAt: null },
    include: { item: true, purchaseOrder: { include: poSummaryInclude } },
    orderBy: { createdAt: "asc" },
  });
  if (requirements.length === 0) return [];

  // Total across Warehouse + every Day Store + every Plant — see
  // getTotalAvailableByItemId's own comment for why Warehouse alone
  // isn't the right figure for "can this PO run."
  const totalOnHand = await getTotalAvailableByItemId([...new Set(requirements.map((r) => r.itemId))]);
  // Decreases as earlier-recorded requirements claim their share —
  // what's actually left for the *next* PO in line to draw against,
  // not the item's raw total.
  const remaining = new Map(totalOnHand);

  const byPo = new Map<string, PoReadinessRow>();
  for (const r of requirements) {
    const available = remaining.get(r.itemId) ?? 0;
    const covered = available >= r.requiredQty;
    if (covered) remaining.set(r.itemId, available - r.requiredQty);

    let row = byPo.get(r.purchaseOrderId);
    if (!row) {
      row = { purchaseOrder: r.purchaseOrder as PoReadinessRow["purchaseOrder"], items: [], totalItems: 0, readyItems: 0, isReady: true };
      byPo.set(r.purchaseOrderId, row);
    }
    // onHand here is "available to *this* PO at its place in the queue"
    // — deliberately not the item's raw total, so two POs competing for
    // the same scarce item visibly show different numbers explaining
    // why one is covered and the other isn't.
    row.items.push({ itemId: r.itemId, itemName: r.item.name, category: r.category, requiredQty: r.requiredQty, unit: r.unit, onHand: available, covered });
    row.totalItems += 1;
    if (covered) row.readyItems += 1;
    if (!covered) row.isReady = false;
  }

  const all = [...byPo.values()];
  return filterPoIds ? all.filter((row) => filterPoIds.includes(row.purchaseOrder.id)) : all;
}

// Single-PO convenience wrapper — the Batch pipeline's creation gate
// (batches.routes.ts) only ever needs one PO's readiness, not the whole
// system's. `null` means "nobody has logged material requirements for
// this PO" — deliberately distinct from `isReady: false`, since the
// gate treats "no data" as nothing to block on (same "no rows =
// unrestricted" convention as everywhere else in this app), not as
// "not ready."
export async function getPoReadinessForOne(purchaseOrderId: string): Promise<PoReadinessRow | null> {
  const [row] = await computeReadiness([purchaseOrderId]);
  return row ?? null;
}
