import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { getMaterialPlanning, type MaterialPlanningResult } from "./material-planning";
import { openQtyOf } from "../inventory/purchase-lines";

/**
 * Sending short material to Purchase is AUTOMATIC: every product in Material
 * Planning that is claiming stock (not on hold, not Regulatory-Not-Approved) and
 * has a material that is SHORT gets a Pre-Inventory shortfall requirement for it
 * - no button needed (the Action menu's "Send Short to Purchase" stays as a
 * manual "send it now"). Purchase is told once per product per sync. A material
 * that is short later (or again) is picked up the same way.
 *
 * The rows it creates (sourcePoItemId set) are then kept in step with Material
 * Planning until Purchase logs a PO against them.
 *
 * Such a Pre-Inventory row (sourcePoItemId set, no PO logged yet) is, on every
 * sync:
 *  - re-quantified when the shortage changed (stock arrived, another product
 *    was cancelled / held / sent, a plan was recalculated ...) - Purchase is told;
 *  - removed when the material is no longer short (covered now, or the product
 *    was cancelled / is gone from Material Planning) - Purchase is told;
 *  - left alone while the product is on hold or Regulatory-Not-Approved (they
 *    don't claim stock, their numbers are only a preview).
 * Once Purchase has logged a PO (purchaseAt set) the row is final - never touched.
 *
 * Called after anything that can move the shortage, and whenever the Material
 * Planning report is opened; failures never break the caller.
 */

type Logger = { error: (obj: unknown, msg: string) => void };

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function syncShortToPurchase(actorId: string | null, planning?: MaterialPlanningResult): Promise<{ created: number; updated: number; removed: number }> {
  const open = await prisma.preInventoryRequirement.findMany({
    // Requirements that already have PI lines stay in step too (their quantity can change), but are never deleted.
    where: { sourcePoItemId: { not: null }, deletedAt: null },
    include: { item: { select: { id: true, name: true, category: true } }, purchaseLines: { select: { quantity: true, receivedQty: true, status: true } } },
  });

  const plan = planning ?? (await getMaterialPlanning());
  const productById = new Map(plan.products.map((p) => [p.purchaseOrderItemId, p]));
  const rowByKey = new Map(plan.rows.map((r) => [`${r.purchaseOrderItemId}::${r.type}::${r.material}`, r]));

  let updated = 0;
  let removed = 0;
  for (const req of open) {
    const product = productById.get(req.sourcePoItemId!);
    if (product && (product.state === "HELD" || product.state === "NOT_APPROVED")) continue;

    const row = rowByKey.get(`${req.sourcePoItemId}::${req.item.category}::${req.item.name}`);
    const label = product ? `${product.productName} (${product.poNumber ?? "PO"})` : "a cancelled / moved product";

    const hasLines = req.purchaseLines.length > 0 || !!req.purchaseAt; // a PI logged the old way (no line row) counts too
    if (!row || row.status !== "SHORT") {
      if (hasLines) continue; // Purchase has PIs on it - never delete; live stock shows it as covered
      await prisma.preInventoryRequirement.update({ where: { id: req.id }, data: { deletedAt: new Date(), deletedById: actorId } });
      await notifyRoles(
        ["PURCHASE"],
        { title: `Shortfall cleared: ${req.item.name}`, body: `${label} - no longer short, no PI needed for this requirement.`, link: "/pre-inventory" },
        actorId ?? undefined,
      ).catch(() => {});
      removed += 1;
      continue;
    }

    // Stored as live stock + shortfall so Pre-Inventory's own "short against live stock" reads the real gap.
    const newQty = round2((row.onHand ?? 0) + (row.shortQty ?? 0));
    if (Math.abs(newQty - req.requiredQty) > 0.005) {
      const oldShort = round2(Math.max(0, req.requiredQty - (row.onHand ?? 0)));
      await prisma.preInventoryRequirement.update({ where: { id: req.id }, data: { requiredQty: newQty } });
      // With PI lines already logged: say so when more is on order than is now short.
      const onOrder = req.purchaseLines.reduce((sum, l) => sum + openQtyOf(l), 0);
      const extra = hasLines ? round2(onOrder - (row.shortQty ?? 0)) : 0;
      await notifyRoles(
        ["PURCHASE"],
        {
          title: `Shortfall updated: ${req.item.name}`,
          body: `${label} - short ${oldShort} -> ${row.shortQty} ${row.unit}.${extra > 0.005 ? ` ${extra} ${row.unit} more is on order than is now short - check the PI lines.` : ""}`,
          link: "/pre-inventory",
        },
        actorId ?? undefined,
      ).catch(() => {});
      updated += 1;
    }
  }

  // --- Automatic send: shortages that don't have a requirement yet.
  // Every requirement still on file for a product+material (even one Purchase has
  // already logged a PO for) counts as "already sent", so nothing is duplicated.
  let created = 0;
  const shortRows = plan.rows.filter((r) => r.status === "SHORT" && !r.isPreview);
  if (shortRows.length > 0) {
    const onFile = await prisma.preInventoryRequirement.findMany({ where: { sourcePoItemId: { not: null }, deletedAt: null }, select: { sourcePoItemId: true, itemId: true } });
    const have = new Set(onFile.map((r) => `${r.sourcePoItemId}::${r.itemId}`));
    const catalog = await prisma.inventoryItem.findMany({
      where: { OR: [{ category: "RM", name: { in: [...new Set(shortRows.filter((r) => r.type === "RM").map((r) => r.material))] } }, { category: "PM", name: { in: [...new Set(shortRows.filter((r) => r.type === "PM").map((r) => r.material))] } }] },
      select: { id: true, category: true, name: true },
    });
    const invByKey = new Map(catalog.map((c) => [`${c.category}::${c.name}`, c.id]));

    const sentPerProduct = new Map<string, number>();
    for (const r of shortRows) {
      const product = productById.get(r.purchaseOrderItemId);
      if (!product || (product.state !== "ACTIVE" && product.state !== "SENT")) continue;
      const invId = invByKey.get(`${r.type}::${r.material}`);
      if (!invId || have.has(`${r.purchaseOrderItemId}::${invId}`)) continue;

      await prisma.preInventoryRequirement.create({
        data: {
          date: new Date(),
          category: r.type,
          itemId: invId,
          unit: r.unit,
          requiredQty: round2((r.onHand ?? 0) + (r.shortQty ?? 0)),
          note: `Material Planning - ${product.poNumber ?? "PO"} / ${product.productName}`,
          sourcePoItemId: r.purchaseOrderItemId,
          requestedById: actorId ?? (await fallbackRequester()),
          purchaseNotifiedAt: new Date(),
        },
      });
      have.add(`${r.purchaseOrderItemId}::${invId}`);
      sentPerProduct.set(r.purchaseOrderItemId, (sentPerProduct.get(r.purchaseOrderItemId) ?? 0) + 1);
      created += 1;
    }

    for (const [itemId, n] of sentPerProduct) {
      const product = productById.get(itemId)!;
      await notifyRoles(
        ["PURCHASE"],
        { title: `Shortfall: ${product.productName}`, body: `${product.poNumber ?? "PO"} - ${n} material(s) short, please log a PI.`, link: "/pre-inventory" },
        actorId ?? undefined,
      ).catch(() => {});
    }
  }

  if (created + updated + removed > 0) {
    await recordAudit({ actorId, action: "purchase_order.short_requirements_synced", entityType: "PreInventoryRequirement", metadata: { created, updated, removed } }).catch(() => {});
  }
  return { created, updated, removed };
}

// requestedById is required on a requirement; a sync with no acting user (not
// currently possible - every caller passes one) falls back to any PPIC user.
async function fallbackRequester(): Promise<string> {
  const ppic = await prisma.user.findFirst({ where: { isActive: true, roles: { some: { role: { name: "PPIC" } } } }, select: { id: true } });
  if (!ppic) throw new Error("No PPIC user to own the shortfall requirement");
  return ppic.id;
}

/** Same, but never throws - for hooking after another action. */
export async function syncShortToPurchaseSafe(actorId: string | null, log?: Logger, planning?: MaterialPlanningResult): Promise<void> {
  try {
    await syncShortToPurchase(actorId, planning);
  } catch (err) {
    log?.error({ err }, "sync short requirements to Purchase failed");
  }
}
