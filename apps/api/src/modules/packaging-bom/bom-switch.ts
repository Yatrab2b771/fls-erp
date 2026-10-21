import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { getMaterialPlanning } from "../purchase-orders/material-planning";
import { syncShortToPurchaseSafe } from "../purchase-orders/purchase-sync";
import { raiseRequestsForPlannedItemSafe } from "../inventory/plan-requests";
import { SLOTS, computePm, computeRm, loadDisplay, resultsForSlot, slotsOf, type PlanSlot, type PmSlotSnapshot, type RmSlotSnapshot } from "./bom-slots";
import { getRequiredDispensingItems } from "../batches/dispensing-requirements";
import { notifyPlantDayStore } from "../inventory/plan-requests";

/**
 * Using a BOM version for a plan (the versions themselves are kept in bom-slots.ts).
 *
 *   GET  /item/:itemId        which version a product's plan is made from, what V1 / V2 hold, and the changes so far
 *   POST /switch              R&D makes the plan of a product (still with PPIC) from Display, V1 or V2: both plans are worked out again from it
 *   GET  /planning-summary    how many products wait in Material Planning (short) and in PO Readiness (covered), for R&D's tiles
 *
 * While the product is still with PPIC (Material Planning / PO Readiness) the change is the plan itself: PPIC sees the new numbers, the Day
 * Store's requests follow, and a product that is now fully covered moves to PO Readiness, from where R&D can send it to Production.
 */
export const bomSwitchRouter = Router();
bomSwitchRouter.use(requireAuth);

const switchSchema = z.object({
  purchaseOrderItemId: z.string().min(1),
  slot: z.enum(["DISPLAY", ...SLOTS]),
  reason: z.string().trim().min(3, "Write why the plan is changed.").max(300),
});

export interface SwitchChange {
  type: string;
  material: string;
  unit: string;
  oldQty: number;
  newQty: number;
}
export interface SwitchBatch {
  batchNo: string | null;
  /** true = already dispensed: it keeps what it was given and the rest of the new version comes as an extra request. */
  dispensed: boolean;
}
export interface SwitchExtra {
  batchNo: string | null;
  material: string;
  unit: string;
  qty: number;
}
export type SwitchResult =
  | { ok: true; slot: PlanSlot; phase: "PLANNING" | "PRODUCTION"; shortages: { type: string; material: string; unit: string; shortQty: number }[]; ready: boolean; changes: SwitchChange[]; batches: SwitchBatch[]; extraRequests: SwitchExtra[] }
  | { ok: false; status: number; error: string };

const SLOT_LABEL: Record<PlanSlot, string> = { DISPLAY: "Display BOM", V1: "V1", V2: "V2" };
const keyOf = (productName: string) => productName.trim().toLowerCase();

export async function switchItemBom(p: { itemId: string; slot: PlanSlot; reason: string; actorId: string; log?: { error: (obj: unknown, msg: string) => void } }): Promise<SwitchResult> {
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: p.itemId },
    select: {
      id: true,
      productName: true,
      deletedAt: true,
      cancelledAt: true,
      materialHeldAt: true,
      planSentToProductionAt: true,
      activeBomSlot: true,
      productionBomSlot: true,
      quantity: true,
      plannedPlantId: true,
      plannedPlant: { select: { dayStoreId: true } },
      purchaseOrder: { select: { id: true, poNumber: true, status: true, customerId: true } },
      rmPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { id: true } },
      bomPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!item || item.deletedAt) return { ok: false, status: 404, error: "Product not found." };
  if (item.cancelledAt) return { ok: false, status: 409, error: "This product is cancelled." };
  if (item.purchaseOrder.status !== "APPROVED") return { ok: false, status: 409, error: "This PO is not approved yet." };
  if (item.materialHeldAt) return { ok: false, status: 409, error: "PPIC has put this product on hold: it can be changed once PPIC releases it." };
  // With Production already: the change is R&D's alone (PPIC's plan is not touched and PPIC is not told), see switchInProduction.
  if (item.planSentToProductionAt) return switchInProduction(item, p);
  if (item.activeBomSlot === p.slot) return { ok: false, status: 409, error: `The plan is already made from ${SLOT_LABEL[p.slot]}.` };
  const rmPlan = item.rmPlans[0];
  const bomPlan = item.bomPlans[0];
  if (!rmPlan || !bomPlan) return { ok: false, status: 409, error: "Both plans (RM and Packaging) have to be calculated first." };

  // Both plans worked out again from the version (a plan with several recipes / SKUs keeps the others as they are).
  const made = await resultsForSlot(item.id, p.slot);
  if (!made.ok) return made;
  const rmResult = made.rm;
  const pmResult = made.pm;

  await prisma.$transaction([
    prisma.rmPlan.update({ where: { id: rmPlan.id }, data: { resultSnapshot: rmResult as unknown as Prisma.InputJsonValue, calculatedAt: new Date() } }),
    prisma.bomPlan.update({ where: { id: bomPlan.id }, data: { resultSnapshot: pmResult as unknown as Prisma.InputJsonValue, calculatedAt: new Date() } }),
    prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { activeBomSlot: p.slot, activeBomChangedAt: new Date(), activeBomChangedById: p.actorId } }),
    prisma.itemBomSwitch.create({ data: { purchaseOrderItemId: item.id, fromSlot: item.activeBomSlot, toSlot: p.slot, reason: p.reason, phase: "PLANNING", actorId: p.actorId } }),
  ]);
  await recordAudit({ actorId: p.actorId, action: "purchase_order.item_bom_switched", entityType: "PurchaseOrderItem", entityId: item.id, metadata: { from: item.activeBomSlot, to: p.slot, reason: p.reason, productName: item.productName } });

  // The Day Store's requests follow the new plan; Purchase hears the new shortages; PPIC is told what R&D did.
  await raiseRequestsForPlannedItemSafe(item.id, p.actorId, p.log);
  await syncShortToPurchaseSafe(p.actorId, p.log);
  await notifyRoles(
    ["PPIC"],
    {
      title: `${item.productName}: R&D changed the plan to ${SLOT_LABEL[p.slot]}`,
      body: `${item.purchaseOrder.poNumber ?? "PO"}: ${p.reason}`,
      link: `/purchase-orders/${item.purchaseOrder.id}`,
    },
    p.actorId,
  ).catch((err) => p.log?.error({ err }, "notify failed: item_bom_switched"));

  const planning = await getMaterialPlanning();
  const rows = planning.rows.filter((r) => r.purchaseOrderItemId === item.id);
  const shortages = rows.filter((r) => r.status === "SHORT").map((r) => ({ type: r.type, material: r.material, unit: r.unit, shortQty: r.shortQty ?? 0 }));
  return { ok: true, slot: p.slot, phase: "PLANNING", shortages, ready: rows.length > 0 && rows.every((r) => r.status === "COVERED"), changes: [], batches: [], extraRequests: [] };
}

// A batch is "open" while R&D can still change what it is made of: not completed yet, or still before Bulk QC has passed.
const BEFORE_PACKAGING = ["IPQC", "QA_GATE_MFG", "BULK_QC"];
const isOpenBatch = (b: { status: string; currentStageId: string }) => b.status === "IN_PROGRESS" || BEFORE_PACKAGING.includes(b.currentStageId);

type SwitchItem = {
  id: string;
  productName: string;
  activeBomSlot: string;
  productionBomSlot: string | null;
  quantity: number;
  plannedPlantId: string | null;
  plannedPlant: { dayStoreId: string | null } | null;
  purchaseOrder: { id: string; poNumber: string | null };
};

async function switchInProduction(item: SwitchItem, p: { itemId: string; slot: PlanSlot; reason: string; actorId: string; log?: { error: (obj: unknown, msg: string) => void } }): Promise<SwitchResult> {
  const batches = await prisma.productionBatch.findMany({
    where: { preProduction: { purchaseOrderItemId: item.id } },
    select: { id: true, batchNo: true, bomSlot: true, status: true, currentStageId: true, dispensedAt: true, plannedQty: true },
    orderBy: { createdAt: "asc" },
  });
  if (batches.length > 0 && !batches.some(isOpenBatch)) {
    return { ok: false, status: 409, error: "Every batch of this product is past Bulk QC: its BOM version can't be changed any more." };
  }
  const current = (item.productionBomSlot ?? item.activeBomSlot) as PlanSlot;
  if (current === p.slot) return { ok: false, status: 409, error: `The product is already made from ${SLOT_LABEL[p.slot]}.` };
  const made = await resultsForSlot(item.id, p.slot);
  if (!made.ok) return made;

  // What changes for the material: the whole order's requirement under the new version against the one it replaces.
  const before = await getRequiredDispensingItems(item.id, item.productionBomSlot);
  const after = await getRequiredDispensingItems(item.id, p.slot);
  const key = (r: { category: string; itemName: string }) => `${r.category}::${r.itemName}`;
  const oldBy = new Map(before.map((r) => [key(r), r]));
  const newBy = new Map(after.map((r) => [key(r), r]));
  const changes: SwitchChange[] = [...new Set([...oldBy.keys(), ...newBy.keys()])]
    .map((k) => {
      const o = oldBy.get(k);
      const n = newBy.get(k);
      const ref = (n ?? o)!;
      return { type: ref.category, material: ref.itemName, unit: ref.unit, oldQty: Math.round((o?.requiredQty ?? 0) * 100) / 100, newQty: Math.round((n?.requiredQty ?? 0) * 100) / 100 };
    })
    .filter((c) => Math.abs(c.newQty - c.oldQty) > 0.005);

  // Back to the plan PPIC sees clears the choice; otherwise it is kept for the product. The batches already dispensed keep what they were given.
  const newProductSlot = p.slot === item.activeBomSlot ? null : p.slot;
  // Dispensed batches past Bulk QC stay as they were; the ones still open follow the new version from now on (their Utilization reads it), and what
  // it needs beyond what they were given is asked from the Day Store as an extra request for that batch (below).
  const openDispensed = batches.filter((b) => isOpenBatch(b) && !!b.dispensedAt);
  await prisma.$transaction([
    prisma.productionBatch.updateMany({
      where: { preProduction: { purchaseOrderItemId: item.id }, bomSlot: null, dispensedAt: { not: null } },
      data: { bomSlot: item.productionBomSlot ?? "BASE" },
    }),
    prisma.productionBatch.updateMany({ where: { id: { in: openDispensed.map((b) => b.id) } }, data: { bomSlot: newProductSlot ?? "BASE" } }),
    prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { productionBomSlot: newProductSlot } }),
    prisma.itemBomSwitch.create({ data: { purchaseOrderItemId: item.id, fromSlot: current, toSlot: p.slot, reason: p.reason, phase: "PRODUCTION", actorId: p.actorId } }),
  ]);
  await recordAudit({ actorId: p.actorId, action: "purchase_order.item_bom_switched_in_production", entityType: "PurchaseOrderItem", entityId: item.id, metadata: { from: current, to: p.slot, reason: p.reason, productName: item.productName } });

  // Production and the Day Store are told; PPIC is not (its plan and lists are untouched).
  const extraRequests = await raiseExtraForBatches(item, openDispensed, newProductSlot, `R&D changed the BOM to ${SLOT_LABEL[p.slot]}: ${p.reason}`, p.actorId);
  const notDispensed = batches.filter((b) => isOpenBatch(b) && !b.dispensedAt).length;
  const body = `${item.purchaseOrder.poNumber ?? "PO"}: R&D changed the BOM to ${SLOT_LABEL[p.slot]} (${p.reason}). ${notDispensed} batch(es) not dispensed yet follow it; ${openDispensed.length} dispensed batch(es) keep their material${extraRequests.length ? ` and ${extraRequests.length} extra request(s) were raised for what they still need` : ""}.`;
  await notifyRoles(["PRODUCTION"], { title: `${item.productName}: R&D changed the BOM to ${SLOT_LABEL[p.slot]}`, body, link: "/batches" }, p.actorId).catch((err) => p.log?.error({ err }, "notify failed: bom switch production"));
  await notifyPlantDayStore(item.plannedPlant?.dayStoreId, { title: `${item.productName}: BOM changed to ${SLOT_LABEL[p.slot]}`, body, link: "/batch-dispensing" }, p.actorId).catch((err) => p.log?.error({ err }, "notify failed: bom switch day store"));

  return {
    ok: true,
    slot: p.slot,
    phase: "PRODUCTION",
    shortages: [],
    ready: true,
    changes,
    batches: batches.filter(isOpenBatch).map((b) => ({ batchNo: b.batchNo, dispensed: !!b.dispensedAt })),
    extraRequests,
  };
}

/**
 * For each dispensed batch still open: what the new version needs for the batch (its share of the order) beyond what it was given, asked from the
 * Day Store as an extra request tied to the batch. Safe to repeat: a request the Day Store has not touched follows the new quantity (or is
 * withdrawn when nothing is needed), one it has started on is counted as already asked, and what was issued against earlier ones is not asked again.
 */
async function raiseExtraForBatches(item: SwitchItem, batches: { id: string; batchNo: string | null; plannedQty: number }[], slotKey: string | null, why: string, actorId: string): Promise<SwitchExtra[]> {
  if (!item.plannedPlantId || batches.length === 0) return [];
  const required = await getRequiredDispensingItems(item.id, slotKey);
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const raised: SwitchExtra[] = [];
  for (const b of batches) {
    const scale = item.quantity > 0 ? b.plannedQty / item.quantity : 1;
    const [lines, requests] = await Promise.all([
      prisma.batchDispensingLine.groupBy({ by: ["itemId"], where: { productionBatchId: b.id, deliveryStatus: { not: "REFUSED" } }, _sum: { quantity: true } }),
      prisma.inventoryRequest.findMany({
        where: { productionBatchId: b.id, isExtra: true, deletedAt: null },
        select: { id: true, itemId: true, requestedQty: true, status: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
      }),
    ]);
    const given = new Map(lines.map((l) => [l.itemId, l._sum.quantity ?? 0]));
    const issuedOf = (r: (typeof requests)[number]) => r.fulfillments.reduce((t, f) => t + f.quantity, 0);
    const untouchedOf = (r: (typeof requests)[number]) => r.status === "PENDING" && r.fulfillments.length === 0;
    const withdraw = (ids: string[]) => (ids.length ? prisma.inventoryRequest.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date(), deletedById: actorId } }) : Promise.resolve());

    for (const r of required) {
      const mine = requests.filter((x) => x.itemId === r.itemId);
      const untouched = mine.filter(untouchedOf);
      const issued = mine.reduce((t, x) => t + issuedOf(x), 0);
      const asked = mine.filter((x) => !untouchedOf(x)).reduce((t, x) => t + Math.max(0, x.requestedQty - issuedOf(x)), 0);
      const need = round3(Math.max(0, r.requiredQty * scale - (given.get(r.itemId) ?? 0) - issued - asked));
      if (need <= 0.0005) {
        await withdraw(untouched.map((x) => x.id));
        continue;
      }
      if (untouched.length > 0) {
        await prisma.inventoryRequest.update({ where: { id: untouched[0]!.id }, data: { requestedQty: need, note: `${why} (batch ${b.batchNo ?? ""})` } });
        await withdraw(untouched.slice(1).map((x) => x.id));
      } else {
        await prisma.inventoryRequest.create({
          data: { itemId: r.itemId, category: r.category, requestedQty: need, purpose: "ISSUED_PRODUCTION", note: `${why} (batch ${b.batchNo ?? ""})`, requestedById: actorId, plantId: item.plannedPlantId, isExtra: true, extraForPoItemId: item.id, productionBatchId: b.id },
        });
      }
      raised.push({ batchNo: b.batchNo, material: r.itemName, unit: r.unit, qty: need });
    }
    // A material the new version no longer needs: an extra the Day Store has not started on is withdrawn.
    await withdraw(requests.filter((x) => untouchedOf(x) && !required.some((r) => r.itemId === x.itemId)).map((x) => x.id));
  }
  return raised;
}

bomSwitchRouter.post("/switch", requireRole("RND"), validateBody(switchSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof switchSchema>;
    const result = await switchItemBom({ itemId: input.purchaseOrderItemId, slot: input.slot, reason: input.reason, actorId: req.user!.id, log: req.log });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

bomSwitchRouter.get("/item/:itemId", async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({
      where: { id: req.params.itemId },
      select: { id: true, productName: true, activeBomSlot: true, productionBomSlot: true, planSentToProductionAt: true, materialHeldAt: true, purchaseOrder: { select: { customerId: true } }, bomSwitches: { orderBy: { createdAt: "desc" }, take: 10 }, preProduction: { select: { productionBatches: { select: { status: true, currentStageId: true } } } } },
    });
    if (!item) return res.status(404).json({ error: "Product not found" });
    const view = await slotsOf(item.purchaseOrder.customerId, item.productName);
    // PPIC never sees what R&D changed once the product is with Production.
    const seesProduction = (req.user?.roles ?? []).some((r) => ["RND", "PRODUCTION", "STORE", "ADMIN"].includes(r));
    const batches = item.preProduction?.productionBatches ?? [];
    const locked = item.planSentToProductionAt && batches.length > 0 && !batches.some(isOpenBatch) ? "Every batch of this product is past Bulk QC." : null;
    const ordered = await prisma.preInventoryRequirement.findMany({
      where: { sourcePoItemId: item.id, deletedAt: null, OR: [{ purchaseAt: { not: null } }, { purchaseLines: { some: {} } }] },
      select: { item: { select: { name: true, category: true } }, purchaseLines: { select: { piNumber: true } } },
    });
    const users = await prisma.user.findMany({ where: { id: { in: item.bomSwitches.map((s) => s.actorId) } }, select: { id: true, fullName: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const half = (s: { rm: unknown; pm: unknown; note: string | null } | null) => (s ? { rm: !!s.rm, pm: !!s.pm, note: s.note } : null);
    res.json({
      itemId: item.id,
      productName: item.productName,
      customerId: item.purchaseOrder.customerId,
      activeSlot: item.planSentToProductionAt && seesProduction ? item.productionBomSlot ?? item.activeBomSlot : item.activeBomSlot,
      phase: item.planSentToProductionAt ? "PRODUCTION" : "PLANNING",
      locked: seesProduction ? locked : "This product is with Production.",
      planSent: !!item.planSentToProductionAt,
      held: !!item.materialHeldAt,
      display: { rm: !!view.display.rm, pm: !!view.display.pm },
      slots: { V1: half(view.slots.V1), V2: half(view.slots.V2) },
      // Purchase has already put a PI on these: they stay (and arrive) whatever the plan becomes.
      onOrder: ordered.map((r) => ({ material: r.item.name, type: r.item.category, pis: r.purchaseLines.map((l) => l.piNumber).filter((x): x is string => !!x) })),
      switches: item.bomSwitches.filter((s) => seesProduction || s.phase !== "PRODUCTION").map((s) => ({ fromSlot: s.fromSlot, toSlot: s.toSlot, reason: s.reason, phase: s.phase, actorName: nameOf.get(s.actorId) ?? null, createdAt: s.createdAt })),
    });
  } catch (err) {
    next(err);
  }
});

bomSwitchRouter.get("/planning-summary", async (_req, res, next) => {
  try {
    const planning = await getMaterialPlanning();
    const waiting = planning.products.filter((p) => !p.planSentToProductionAt && p.state !== "HELD");
    res.json({
      short: waiting.filter((p) => p.hasShortfall).length,
      ready: waiting.filter((p) => !p.hasShortfall && p.materialCount > 0).length,
      changedByRnd: waiting.filter((p) => p.activeBomSlot !== "DISPLAY").length,
    });
  } catch (err) {
    next(err);
  }
});

// R&D's list of products that are with Production and whose batches can still be changed (the "In Production: BOM change" tile).
bomSwitchRouter.get("/in-production", requireRole("RND"), async (_req, res, next) => {
  try {
    const items = await prisma.purchaseOrderItem.findMany({
      where: { deletedAt: null, cancelledAt: null, planSentToProductionAt: { not: null }, purchaseOrder: { status: "APPROVED" } },
      select: {
        id: true,
        productName: true,
        quantity: true,
        unit: true,
        activeBomSlot: true,
        productionBomSlot: true,
        materialHeldAt: true,
        plannedPlant: { select: { name: true } },
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: { select: { productionBatches: { select: { status: true, currentStageId: true, dispensedAt: true } } } },
      },
      orderBy: { planSentToProductionAt: "asc" },
      take: 300,
    });
    res.json(
      items
        .map((i) => ({ i, batches: i.preProduction?.productionBatches ?? [] }))
        .filter(({ batches }) => batches.length === 0 || batches.some(isOpenBatch))
        .map(({ i, batches }) => ({
          purchaseOrderItemId: i.id,
          purchaseOrderId: i.purchaseOrder.id,
          poNumber: i.purchaseOrder.poNumber,
          customerName: i.purchaseOrder.customer.companyName,
          productName: i.productName,
          plantName: i.plannedPlant?.name ?? null,
          quantity: i.quantity,
          unit: i.unit,
          activeBomSlot: i.productionBomSlot ?? i.activeBomSlot,
          held: !!i.materialHeldAt,
          batches: {
            total: batches.length,
            notDispensed: batches.filter((b) => !b.dispensedAt && isOpenBatch(b)).length,
            inProduction: batches.filter((b) => !!b.dispensedAt && isOpenBatch(b)).length,
            beyond: batches.filter((b) => !isOpenBatch(b)).length,
          },
        })),
    );
  } catch (err) {
    next(err);
  }
});
