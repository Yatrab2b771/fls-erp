import { prisma } from "../../common/lib/prisma";
import { getTotalAvailableByItemId } from "../inventory/stock";
import { computeCompletion, poInclude } from "./po-completion";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import type { BomResult } from "../packaging-bom/bom-engine";

/**
 * Per-product RM/PM material breakdown for the Pending PO Report — one
 * row per line item of every pending PO (same "pending" definition as
 * everywhere else in this app: not REJECTED, computeCompletion says not
 * completed — see purchase-orders.routes.ts), reading each product's
 * own latest CALCULATED RM Plan (RM Costing) / BOM Plan (Packaging)
 * resultSnapshot instead of requiring PPIC to separately upload PO
 * Material Requirement rows (po-readiness/readiness-engine.ts) — every
 * pending product already has this once its plan is calculated, so this
 * covers the whole pending list instead of only the subset PPIC has
 * manually logged there.
 *
 * Deliberately simpler than readiness-engine.ts's own allocation: no
 * cross-PO "first requirement claims it" ordering here — onHand is each
 * item's live company-wide total, compared independently per row. Two
 * pending products competing for the same scarce material can both show
 * "enough" — an accepted simplification for an at-a-glance report, not
 * meant to replace po-readiness's own queue-aware number.
 */

export interface PendingMaterialLine {
  name: string;
  requiredQty: number;
  unit: string;
  // null when the plan's material name doesn't match any real catalog
  // item (InventoryItem, matched by category+name) — happens for BOM
  // Plan lines built off the legacy fixed spec fields (e.g. "Jar/
  // Container"), which are generic labels, not real catalog names. Qty
  // still shown; just nothing to compare it against.
  onHand: number | null;
  short: boolean;
  shortfallQty: number;
}

export interface PendingPoMaterialRow {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  poNumber: string | null;
  customerName: string;
  orderDate: string | null;
  productName: string;
  quantity: number;
  unit: string;
  rmPlanned: boolean;
  bomPlanned: boolean;
  rmMaterials: PendingMaterialLine[];
  pmMaterials: PendingMaterialLine[];
}

export async function getPendingPoMaterials(): Promise<PendingPoMaterialRow[]> {
  const orders = await prisma.purchaseOrder.findMany({ where: { status: { not: "REJECTED" } }, include: poInclude, orderBy: { createdAt: "asc" } });
  const pendingOrders = orders.filter((po) => !computeCompletion(po).isCompleted);
  const pendingItemIds = pendingOrders.flatMap((po) => po.items.map((item) => item.id));
  if (pendingItemIds.length === 0) return [];

  const items = await prisma.purchaseOrderItem.findMany({
    where: { id: { in: pendingItemIds } },
    select: {
      id: true,
      productName: true,
      quantity: true,
      unit: true,
      purchaseOrder: {
        select: { id: true, poNumber: true, orderDate: true, createdAt: true, customer: { select: { companyName: true } } },
      },
      rmPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true } },
      bomPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Collect every distinct (category, name) this batch of plans
  // mentions, resolve each to a real InventoryItem once, then fetch
  // live stock for all of them in one shot — same "resolve everything
  // up front, one bulk stock read" shape as readiness-engine.ts.
  type Need = { category: "RM" | "PM"; name: string; qty: number };
  const rmNeedsByItem = new Map<string, Need[]>();
  const pmNeedsByItem = new Map<string, Need[]>();
  const namesByCategory = new Map<string, Set<string>>([
    ["RM", new Set<string>()],
    ["PM", new Set<string>()],
  ]);

  for (const item of items) {
    const rmSnapshot = item.rmPlans[0]?.resultSnapshot as unknown as RmMasterResult | undefined;
    const rmNeeds: Need[] = (rmSnapshot?.procurement ?? [])
      .filter((p) => p.totalKg > 0)
      .map((p) => ({ category: "RM" as const, name: p.name.trim(), qty: p.totalKg }));
    if (rmNeeds.length) rmNeedsByItem.set(item.id, rmNeeds);
    for (const n of rmNeeds) namesByCategory.get("RM")!.add(n.name);

    const bomSnapshot = item.bomPlans[0]?.resultSnapshot as unknown as BomResult | undefined;
    const pmNeeds: Need[] = (bomSnapshot?.lines ?? [])
      .filter((l) => l.totalQty > 0)
      .map((l) => ({ category: "PM" as const, name: l.component.trim(), qty: l.totalQty }));
    if (pmNeeds.length) pmNeedsByItem.set(item.id, pmNeeds);
    for (const n of pmNeeds) namesByCategory.get("PM")!.add(n.name);
  }

  const catalogItems = await prisma.inventoryItem.findMany({
    where: {
      OR: [
        { category: "RM", name: { in: [...namesByCategory.get("RM")!] } },
        { category: "PM", name: { in: [...namesByCategory.get("PM")!] } },
      ],
    },
    select: { id: true, category: true, name: true, unit: true },
  });
  const catalogByKey = new Map(catalogItems.map((c) => [`${c.category}::${c.name}`, c]));

  const stockById = await getTotalAvailableByItemId(catalogItems.map((c) => c.id));

  function toLines(needs: Need[] | undefined): PendingMaterialLine[] {
    if (!needs) return [];
    // Same across-product qty merge every other bulk report in this app
    // does (readiness-engine.ts, the BD/PPIC report) — two lines for the
    // same material on one product's plan (rare, but possible from a
    // multi-recipe RM plan) fold into one row.
    const merged = new Map<string, Need>();
    for (const n of needs) {
      const key = `${n.category}::${n.name}`;
      const existing = merged.get(key);
      merged.set(key, existing ? { ...existing, qty: existing.qty + n.qty } : n);
    }
    return [...merged.values()].map((n) => {
      const catalogItem = catalogByKey.get(`${n.category}::${n.name}`);
      const onHand = catalogItem ? stockById.get(catalogItem.id) ?? 0 : null;
      const short = onHand !== null && onHand < n.qty;
      return {
        name: n.name,
        requiredQty: Math.round(n.qty * 100) / 100,
        unit: catalogItem?.unit ?? (n.category === "RM" ? "Kg" : "Nos"),
        onHand: onHand !== null ? Math.round(onHand * 100) / 100 : null,
        short,
        shortfallQty: short ? Math.round((n.qty - onHand!) * 100) / 100 : 0,
      };
    });
  }

  return items.map((item) => ({
    purchaseOrderId: item.purchaseOrder.id,
    purchaseOrderItemId: item.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    orderDate: (item.purchaseOrder.orderDate ?? item.purchaseOrder.createdAt).toISOString(),
    productName: item.productName,
    quantity: item.quantity,
    unit: item.unit,
    rmPlanned: !!item.rmPlans[0],
    bomPlanned: !!item.bomPlans[0],
    rmMaterials: toLines(rmNeedsByItem.get(item.id)),
    pmMaterials: toLines(pmNeedsByItem.get(item.id)),
  }));
}
