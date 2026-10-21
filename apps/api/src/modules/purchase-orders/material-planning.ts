import { prisma } from "../../common/lib/prisma";
import { getTotalAvailableByItemId } from "../inventory/stock";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import { pmLineName, type BomResult } from "../packaging-bom/bom-engine";
import { allowedKeysOf, rulesForPoItems, vendorStockByItem } from "../product-vendors/vendor-rules";

/**
 * Material Planning — for every PO product whose plans have been generated
 * (BOTH a CALCULATED RM plan and a CALCULATED BOM/packaging plan) and that
 * Production hasn't started on yet, one row per raw/packaging material with how much of the requirement
 * live stock actually covers, and how much is short.
 *
 * Unlike the older Pending PO report (which checks each product against the
 * stock independently), this ALLOCATES the stock across products in a queue,
 * so two products competing for the same scarce material can't both show
 * "covered". Queue order, top claims first:
 *   1. Plans already sent to Production — a firm claim, earliest-sent first.
 *   2. Everything else that is claiming — FIFO by the PO's order date
 *      (falling back to when it was created), then the product's own order.
 *   3. Products that don't claim: PPIC "Hold" and Regulatory "Not Approved".
 *      They take nothing from the stock; their numbers are a preview of what
 *      they'd get if released/approved now (computed after every claimer).
 *
 * Whether a material is short has nothing to do with Regulatory — it can
 * approve a product whose materials are short — so that status is only
 * carried along for display and for the "Not Approved doesn't claim" rule.
 *
 * Stock is the live company-wide total (Warehouse + Day Stores + Plants +
 * R&D store — see getTotalAvailableByItemId). Products Production already
 * started on are left out: their material is being/has been issued, so it is
 * already out of that total and must not be counted a second time.
 */

export type MaterialType = "RM" | "PM";
export type MaterialStatus = "COVERED" | "SHORT" | "NOT_IN_CATALOG";
// SENT = plan already sent to Production; ACTIVE = claims stock in the FIFO
// queue; HELD / NOT_APPROVED = doesn't claim (preview numbers only).
export type MaterialProductState = "SENT" | "ACTIVE" | "HELD" | "NOT_APPROVED";

export interface MaterialPlanningRow {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  type: MaterialType;
  material: string;
  unit: string;
  requiredQty: number;
  // Live company-wide stock of this material; null when the plan's name
  // doesn't match any catalog item (nothing to compare against).
  onHand: number | null;
  // Approved vendors: when the product may take this material only from certain vendors, their names and how much of the stock is
  // theirs (the rest is not counted for this product). null/[] when the material is unrestricted.
  approvedVendors: string[];
  approvedOnHand: number | null;
  coveredQty: number | null;
  shortQty: number | null;
  status: MaterialStatus;
  // true for a HELD / NOT_APPROVED product: covered/short are "if released".
  isPreview: boolean;
}

export interface MaterialPlanningProduct {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  quantity: number;
  unit: string;
  regulatoryStatus: string | null;
  // Plant PPIC assigned for production - Send to Production needs one.
  plannedPlantId: string | null;
  sentToRegulatoryAt: string | null;
  planSentToProductionAt: string | null;
  // Set while PPIC has released only part of the order to Production (the product stays in these lists until all of it is out).
  releasedQty: number | null;
  heldAt: string | null;
  state: MaterialProductState;
  materialCount: number;
  shortCount: number;
  hasShortfall: boolean;
  rmPlanned: boolean;
  bomPlanned: boolean;
  // When both plans were calculated - the product has been in Material Planning since then (its Aging).
  plannedAt: string | null;
  // The BOM version its plan is made from: DISPLAY (the catalog's own) or one of R&D's V1 / V2.
  activeBomSlot: string;
}

export interface MaterialPlanningResult {
  products: MaterialPlanningProduct[];
  rows: MaterialPlanningRow[];
}

type Need = { type: MaterialType; name: string; qty: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The later of the two plans' calculation times - the moment the product became fully planned. */
function plannedAtOf(rm: Date | null | undefined, bom: Date | null | undefined): string | null {
  const times = [rm, bom].filter((d): d is Date => !!d).map((d) => d.getTime());
  return times.length === 2 ? new Date(Math.max(...times)).toISOString() : null;
}

export async function getMaterialPlanning(): Promise<MaterialPlanningResult> {
  const items = await prisma.purchaseOrderItem.findMany({
    where: {
      deletedAt: null,
      cancelledAt: null,
      // Once Production has started a run the product leaves these lists - except while PPIC has only released PART of the order
      // (releasedQty set): it stays until the whole quantity has been released.
      OR: [{ preProduction: null }, { planSentToProductionAt: { not: null }, releasedQty: { not: null } }],
      purchaseOrder: { status: "APPROVED" },
      // Only once BOTH the RM plan and the packaging (BOM) plan are calculated —
      // half a plan would show half the materials and a misleading "covered".
      AND: [{ rmPlans: { some: { status: "CALCULATED" } } }, { bomPlans: { some: { status: "CALCULATED" } } }],
    },
    select: {
      id: true,
      productName: true,
      productCategory: true,
      quantity: true,
      releasedQty: true,
      unit: true,
      createdAt: true,
      regulatoryStatus: true,
      plannedPlantId: true,
      sentToRegulatoryAt: true,
      activeBomSlot: true,
      planSentToProductionAt: true,
      materialHeldAt: true,
      purchaseOrder: { select: { id: true, poNumber: true, orderDate: true, createdAt: true, customer: { select: { companyName: true } } } },
      rmPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true, calculatedAt: true } },
      bomPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true, calculatedAt: true } },
    },
  });
  if (items.length === 0) return { products: [], rows: [] };

  // --- Each product's material needs, straight off its latest calculated plans.
  const needsByItem = new Map<string, Need[]>();
  const namesByType: Record<MaterialType, Set<string>> = { RM: new Set(), PM: new Set() };
  for (const item of items) {
    const rm = item.rmPlans[0]?.resultSnapshot as unknown as RmMasterResult | undefined;
    const bom = item.bomPlans[0]?.resultSnapshot as unknown as BomResult | undefined;
    const merged = new Map<string, Need>();
    const add = (type: MaterialType, name: string, qty: number) => {
      const key = `${type}::${name}`;
      const existing = merged.get(key);
      merged.set(key, existing ? { ...existing, qty: existing.qty + qty } : { type, name, qty });
    };
    for (const p of rm?.procurement ?? []) if (p.totalKg > 0) add("RM", p.name.trim(), p.totalKg);
    for (const l of bom?.lines ?? []) if (l.totalQty > 0) add("PM", pmLineName(l), l.totalQty);
    needsByItem.set(item.id, [...merged.values()]);
    for (const n of merged.values()) namesByType[n.type].add(n.name);
  }

  const catalogItems = await prisma.inventoryItem.findMany({
    where: { OR: [{ category: "RM", name: { in: [...namesByType.RM] } }, { category: "PM", name: { in: [...namesByType.PM] } }] },
    select: { id: true, category: true, name: true, unit: true },
  });
  const catalogByKey = new Map(catalogItems.map((c) => [`${c.category}::${c.name}`, c]));
  const stock = await getTotalAvailableByItemId(catalogItems.map((c) => c.id));

  // --- Approved vendors. A product that may take a material only from certain vendors counts only THEIR stock as available for it.
  // The stock of each such material is split by vendor (from the lots); a restricted claim draws only from its approved vendors, and an
  // unrestricted claim draws from stock no restricted product is waiting on first, so it cannot eat a restricted product's share.
  const rules = await rulesForPoItems(items.map((i) => i.id));
  const restrictedItemIds = [...new Set([...rules.values()].flatMap((m) => [...m.entries()].filter(([, r]) => allowedKeysOf(r)).map(([itemId]) => itemId)))];
  const vendorStock = await vendorStockByItem(restrictedItemIds);
  const reservedKeys = new Map<string, Set<string>>();
  for (const m of rules.values()) for (const [itemId, r] of m) for (const k of allowedKeysOf(r) ?? []) reservedKeys.set(itemId, (reservedKeys.get(itemId) ?? new Set()).add(k));

  // --- Queue.
  const stateOf = (i: (typeof items)[number]): MaterialProductState =>
    i.planSentToProductionAt && i.releasedQty == null ? "SENT" : i.materialHeldAt ? "HELD" : i.regulatoryStatus === "Not Approved" ? "NOT_APPROVED" : "ACTIVE";
  const fifoKey = (i: (typeof items)[number]) => (i.purchaseOrder.orderDate ?? i.purchaseOrder.createdAt).getTime();
  const fifo = (a: (typeof items)[number], b: (typeof items)[number]) => fifoKey(a) - fifoKey(b) || a.createdAt.getTime() - b.createdAt.getTime();

  const sent = items.filter((i) => stateOf(i) === "SENT").sort((a, b) => a.planSentToProductionAt!.getTime() - b.planSentToProductionAt!.getTime());
  const active = items.filter((i) => stateOf(i) === "ACTIVE").sort(fifo);
  const nonClaiming = items.filter((i) => ["HELD", "NOT_APPROVED"].includes(stateOf(i))).sort(fifo);

  const balance = new Map(stock); // what's still unclaimed, per catalog item id
  const rows: MaterialPlanningRow[] = [];

  function allocate(item: (typeof items)[number], claim: boolean) {
    const preview = !claim;
    for (const need of needsByItem.get(item.id) ?? []) {
      const catalogItem = catalogByKey.get(`${need.type}::${need.name}`);
      const base = {
        purchaseOrderId: item.purchaseOrder.id,
        purchaseOrderItemId: item.id,
        poNumber: item.purchaseOrder.poNumber,
        customerName: item.purchaseOrder.customer.companyName,
        productName: item.productName,
        productCategory: item.productCategory,
        type: need.type,
        material: need.name,
        requiredQty: round2(need.qty),
        isPreview: preview,
      };
      if (!catalogItem) {
        rows.push({ ...base, unit: need.type === "RM" ? "Kg" : "Nos", approvedVendors: [], approvedOnHand: null, onHand: null, coveredQty: null, shortQty: null, status: "NOT_IN_CATALOG" });
        continue;
      }
      const total = Math.max(0, balance.get(catalogItem.id) ?? 0);
      const rule = rules.get(item.id)?.get(catalogItem.id);
      const keys = allowedKeysOf(rule);
      const vendors = vendorStock.get(catalogItem.id);
      // Restricted: only the approved vendors' remaining stock is available to this product.
      const approvedLeft = keys && vendors ? [...keys].reduce((s, k) => s + (vendors.get(k)?.qty ?? 0), 0) : keys ? 0 : null;
      const available = approvedLeft === null ? total : Math.min(total, approvedLeft);
      const covered = Math.min(need.qty, available);
      // Claimers take their share out of the balance; a non-claimer's preview
      // also draws it down (against the other previews only — every claimer
      // has already been through by then) so two held products competing for
      // the same material don't both preview as fully covered.
      balance.set(catalogItem.id, total - covered);
      if (vendors) {
        // Take it out of the vendors' balances too: a restricted claim from its approved vendors; an unrestricted one first from stock
        // that is not attributed to a vendor, then from vendors no restricted product waits on, and only then from the reserved ones.
        const drawFrom = (order: string[], qty: number) => {
          let left = qty;
          for (const k of order) {
            const v = vendors.get(k);
            if (!v || left <= 1e-9) continue;
            const take = Math.min(v.qty, left);
            v.qty -= take;
            left -= take;
          }
          return left;
        };
        if (keys) drawFrom([...keys], covered);
        else {
          const attributed = [...vendors.values()].reduce((s, v) => s + v.qty, 0);
          const unattributed = Math.max(0, total - attributed);
          const rest = Math.max(0, covered - unattributed);
          const reserved = reservedKeys.get(catalogItem.id) ?? new Set<string>();
          const open = [...vendors.keys()].filter((k) => !reserved.has(k));
          const left = drawFrom(open, rest);
          drawFrom([...reserved], left);
        }
      }
      const short = need.qty - covered;
      rows.push({
        ...base,
        unit: catalogItem.unit ?? (need.type === "RM" ? "Kg" : "Nos"),
        approvedVendors: keys && rule ? rule.vendorNames : [],
        approvedOnHand: keys && vendors ? round2([...keys].reduce((s, k) => s + (vendors.get(k)?.qty ?? 0), 0) + covered) : null,
        onHand: round2(stock.get(catalogItem.id) ?? 0),
        coveredQty: round2(covered),
        shortQty: round2(short),
        status: short > 1e-9 ? "SHORT" : "COVERED",
      });
    }
  }

  for (const item of [...sent, ...active]) allocate(item, true);
  for (const item of nonClaiming) allocate(item, false);

  const products: MaterialPlanningProduct[] = [...sent, ...active, ...nonClaiming].map((item) => {
    const itemRows = rows.filter((r) => r.purchaseOrderItemId === item.id);
    const shortCount = itemRows.filter((r) => r.status === "SHORT").length;
    return {
      purchaseOrderId: item.purchaseOrder.id,
      purchaseOrderItemId: item.id,
      poNumber: item.purchaseOrder.poNumber,
      customerName: item.purchaseOrder.customer.companyName,
      productName: item.productName,
      productCategory: item.productCategory,
      quantity: item.quantity,
      unit: item.unit,
      regulatoryStatus: item.regulatoryStatus,
      plannedPlantId: item.plannedPlantId,
      sentToRegulatoryAt: item.sentToRegulatoryAt?.toISOString() ?? null,
      planSentToProductionAt: item.planSentToProductionAt?.toISOString() ?? null,
      releasedQty: item.planSentToProductionAt ? item.releasedQty : null,
      heldAt: item.materialHeldAt?.toISOString() ?? null,
      state: stateOf(item),
      materialCount: itemRows.length,
      shortCount,
      hasShortfall: shortCount > 0,
      rmPlanned: !!item.rmPlans[0],
      bomPlanned: !!item.bomPlans[0],
      plannedAt: plannedAtOf(item.rmPlans[0]?.calculatedAt, item.bomPlans[0]?.calculatedAt),
      activeBomSlot: item.activeBomSlot,
    };
  });

  return { products, rows };
}
