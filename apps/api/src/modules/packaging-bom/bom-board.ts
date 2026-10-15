import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";
import { hasBomSpec } from "./bom-engine";
import { isWorkableUnit, parsePackKg } from "../purchase-orders/order-conversion";

// R&D's BOM tile: for every product on an approved PO that has not been sent to Production yet, is its RM BOM (recipe) and its Packaging BOM
// ready? Matched the way Generate matches them: customer + product name.

export type BomPartStatus = "READY" | "MISSING" | "COMMON" | "OLD_SPEC" | "NOT_APPLICABLE";

export interface BomBoardRow {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerId: string;
  customerName: string;
  productName: string;
  productCategory: string | null;
  quantity: number;
  unit: string;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  rm: BomPartStatus;
  rmVersion: number | null;
  pm: BomPartStatus;
  pmVersion: number | null;
  /** The pack size is what turns Kg into packs and packs into Kg, so a plan cannot be worked out without it. */
  packSizeKnown: boolean;
  needsWork: boolean;
  waitingSince: string;
}

export const bomBoardRouter = Router();
bomBoardRouter.use(requireAuth, requireRole("RND", "PPIC"));

bomBoardRouter.get("/", async (_req, res, next) => {
  try {
    const items = await prisma.purchaseOrderItem.findMany({
      where: { deletedAt: null, cancelledAt: null, planSentToProductionAt: null, purchaseOrder: { status: "APPROVED" } },
      select: {
        id: true,
        productName: true,
        productCategory: true,
        quantity: true,
        unit: true,
        packSize: true,
        purchaseOrder: { select: { id: true, poNumber: true, customerId: true, orderDate: true, expectedDeliveryDate: true, reviewedAt: true, createdAt: true, customer: { select: { companyName: true } } } },
      },
    });
    if (items.length === 0) return res.json([]);
    const customerIds = [...new Set(items.map((i) => i.purchaseOrder.customerId))];
    const names = [...new Set(items.map((i) => i.productName.trim().toLowerCase()))];

    const [skus, recipes] = await Promise.all([
      prisma.sku.findMany({
        where: { customerId: { in: customerIds } },
        select: { id: true, customerId: true, productName: true, packSize: true, jar: true, wadMm: true, scoopMl: true, silicaGelGms: true, silicaGelQtyNos: true, authenticationSticker: true, capSticker: true, capLockSticker: true, neckSleeve: true, shrink: true, innerPackaging: true, leaflet: true, corrugatedBoxMm: true, packagingSizeNos: true, _count: { select: { packagingComponents: true } } },
      }),
      prisma.recipe.findMany({ where: { OR: [{ customerId: { in: customerIds } }, { customerId: null }] }, select: { id: true, customerId: true, name: true, avgUnitWeightMg: true, _count: { select: { ingredients: true } } } }),
    ]);
    const ids = [...skus.map((s) => s.id), ...recipes.map((r) => r.id)];
    const versions = await prisma.bomVersion.groupBy({ by: ["entityId"], where: { entityId: { in: ids } }, _max: { version: true } });
    const latest = new Map(versions.map((v) => [v.entityId, v._max.version ?? null]));

    const skuOf = new Map(skus.map((s) => [`${s.customerId}|${s.productName.trim().toLowerCase()}`, s]));
    const own = new Map(recipes.filter((r) => r.customerId).map((r) => [`${r.customerId}|${r.name.trim().toLowerCase()}`, r]));
    const common = new Map(recipes.filter((r) => !r.customerId).map((r) => [r.name.trim().toLowerCase(), r]));
    void names;

    const rows: BomBoardRow[] = items.map((i) => {
      const key = i.productName.trim().toLowerCase();
      const cid = i.purchaseOrder.customerId;
      const sku = skuOf.get(`${cid}|${key}`);
      const rec = own.get(`${cid}|${key}`);
      let rm: BomPartStatus;
      if (!isWorkableUnit(i.unit)) rm = "NOT_APPLICABLE";
      else if (rec && rec._count.ingredients > 0) rm = "READY";
      else if (common.has(key)) rm = "COMMON";
      else rm = "MISSING";
      let pm: BomPartStatus = "MISSING";
      if (sku) {
        if (sku._count.packagingComponents > 0) pm = "READY";
        else if (hasBomSpec({ spec: sku })) pm = "OLD_SPEC";
      }
      const gummyMg = rec?.avgUnitWeightMg ?? null;
      const packSizeKnown = parsePackKg(i.packSize, gummyMg) != null || parsePackKg(sku?.packSize, gummyMg) != null;
      const needsWork = rm === "MISSING" || rm === "COMMON" || pm === "MISSING" || pm === "OLD_SPEC" || !packSizeKnown;
      return {
        itemId: i.id,
        poId: i.purchaseOrder.id,
        poNumber: i.purchaseOrder.poNumber,
        customerId: cid,
        customerName: i.purchaseOrder.customer.companyName,
        productName: i.productName,
        productCategory: i.productCategory,
        quantity: i.quantity,
        unit: i.unit,
        orderDate: i.purchaseOrder.orderDate?.toISOString() ?? null,
        expectedDeliveryDate: i.purchaseOrder.expectedDeliveryDate?.toISOString() ?? null,
        rm,
        rmVersion: rec ? (latest.get(rec.id) ?? null) : null,
        pm,
        pmVersion: sku ? (latest.get(sku.id) ?? null) : null,
        packSizeKnown,
        needsWork,
        waitingSince: (i.purchaseOrder.reviewedAt ?? i.purchaseOrder.createdAt).toISOString(),
      };
    });
    rows.sort((a, b) => (a.poNumber ?? "").localeCompare(b.poNumber ?? "", undefined, { numeric: true }) || a.productName.localeCompare(b.productName));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
