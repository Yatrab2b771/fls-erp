import { prisma } from "../../common/lib/prisma";
import { getPoItemPlanAvailability } from "../planning/add-on-plan";
import { getOnHandByDayStoreAndItem } from "../inventory/stock";

/**
 * How much of a product's plan material has reached its Plant, for the part PPIC has released to Production.
 *
 *   required     the plan's quantity, scaled to the released part of the order
 *   at the Plant issued by the Day Store to the Plant against this product's requests and delivered
 *   at Day Store on the Plant's Day Store shelf for this product (what other products' earlier requests are waiting for is
 *                kept back, so the same stock is never counted for two products)
 *   in transit   issued, not yet received by the Plant
 *
 * Covered = at the Plant + at the Day Store reaches the required quantity. Material Received & GRN (the first stage of a run) is
 * recorded once everything the released quantity needs has reached the Day Store (or the Plant); a partial release therefore
 * needs only its own share.
 */
export interface CoverageLine {
  material: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
  /** At the Plant: issued by the Day Store and delivered. */
  receivedQty: number;
  /** On the Day Store's shelf for this product. */
  atDayStoreQty: number;
  inTransitQty: number;
  shortQty: number;
  covered: boolean;
}

export interface MaterialCoverage {
  releasedQty: number;
  orderQty: number;
  unit: string;
  lines: CoverageLine[];
  allCovered: boolean;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export async function getMaterialCoverage(poItemId: string): Promise<MaterialCoverage | null> {
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: poItemId },
    select: { id: true, quantity: true, unit: true, releasedQty: true, planSentToProductionAt: true, plannedPlant: { select: { dayStoreId: true } } },
  });
  if (!item) return null;
  const released = Math.min(item.quantity, item.releasedQty ?? item.quantity);
  const factor = item.quantity > 0 ? released / item.quantity : 1;

  const plan = await getPoItemPlanAvailability(item.id);
  const materials = [...(plan.rm?.materials ?? []).map((m) => ({ ...m, category: "RM" as const })), ...(plan.bom?.materials ?? []).map((m) => ({ ...m, category: "PM" as const }))];
  if (materials.length === 0) return { releasedQty: released, orderQty: item.quantity, unit: item.unit, lines: [], allCovered: true };

  const catalog = await prisma.inventoryItem.findMany({ where: { name: { in: materials.map((m) => m.name) } }, select: { id: true, category: true, name: true } });
  const idOf = new Map(catalog.map((c) => [`${c.category}::${c.name}`, c.id]));
  const requests = await prisma.inventoryRequest.findMany({
    where: { purpose: "ISSUED_PRODUCTION", deletedAt: null, purchaseOrderItemId: item.id, itemId: { in: catalog.map((c) => c.id) } },
    select: { itemId: true, createdAt: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true, deliveredAt: true } } },
  });
  const firstAsked = new Map<string, Date>();
  for (const r of requests) if (!firstAsked.has(r.itemId) || r.createdAt < firstAsked.get(r.itemId)!) firstAsked.set(r.itemId, r.createdAt);

  // The Day Store's shelf, less what other products asked for earlier (they are served first).
  const dayStoreId = item.plannedPlant?.dayStoreId ?? null;
  const shelf = new Map<string, number>();
  if (dayStoreId) {
    const onHand = await getOnHandByDayStoreAndItem(dayStoreId, catalog.map((c) => c.id));
    const earlierOthers = await prisma.inventoryRequest.findMany({
      where: { purpose: "ISSUED_PRODUCTION", deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] }, itemId: { in: catalog.map((c) => c.id) }, plant: { dayStoreId }, purchaseOrderItemId: { not: item.id } },
      select: { itemId: true, createdAt: true, requestedQty: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
    });
    for (const c of catalog) {
      const mine = firstAsked.get(c.id);
      const held = earlierOthers
        .filter((o) => o.itemId === c.id && (!mine || o.createdAt < mine))
        .reduce((sum, o) => sum + Math.max(0, o.requestedQty - o.fulfillments.reduce((x, f) => x + f.quantity, 0)), 0);
      shelf.set(c.id, Math.max(0, (onHand.get(c.id)?.onHand ?? 0) - held));
    }
  }
  const got = new Map<string, { delivered: number; transit: number }>();
  for (const r of requests) {
    const cur = got.get(r.itemId) ?? { delivered: 0, transit: 0 };
    for (const f of r.fulfillments) (f.deliveredAt ? (cur.delivered += f.quantity) : (cur.transit += f.quantity));
    got.set(r.itemId, cur);
  }

  const lines: CoverageLine[] = materials.map((m) => {
    const id = idOf.get(`${m.category}::${m.name}`);
    const g = id ? got.get(id) : undefined;
    const requiredQty = r3(m.requiredQty * factor);
    const receivedQty = r3(g?.delivered ?? 0);
    const atDayStoreQty = r3(Math.min(id ? (shelf.get(id) ?? 0) : 0, Math.max(0, requiredQty - receivedQty)));
    // The plan's quantities are rounded to 2 decimals while the requests keep 3: a hundredth short is not short.
    const covered = receivedQty + atDayStoreQty >= requiredQty - Math.max(0.01, requiredQty * 0.001);
    return {
      material: m.name,
      category: m.category,
      unit: m.unit,
      requiredQty,
      receivedQty,
      atDayStoreQty,
      inTransitQty: r3(g?.transit ?? 0),
      shortQty: covered ? 0 : Math.max(0, r3(requiredQty - receivedQty - atDayStoreQty)),
      covered,
    };
  });
  return { releasedQty: released, orderQty: item.quantity, unit: item.unit, lines, allCovered: lines.every((l) => l.covered) };
}
