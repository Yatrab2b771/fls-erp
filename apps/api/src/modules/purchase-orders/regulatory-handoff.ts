import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";

/**
 * Automatic hand-off to Regulatory: called right after a BOM/RM plan linked
 * to a PO product reaches CALCULATED (create-with-auto-match and the manual
 * Calculate route, on both plan types). That is what puts the product in
 * Regulatory's review queue — PPIC has no separate "send" step.
 *
 * Rules:
 *  - Not sent yet          -> mark sent + notify Regulatory.
 *  - Already awaiting      -> nothing (idempotent — a recalculation doesn't re-notify).
 *  - Already Approved      -> nothing (a recalculation doesn't undo an approval).
 *  - Not Approved          -> PPIC recalculated the plan to fix it, so reset the
 *                             decision and send it again for a fresh review.
 *  - Plan already sent to Production, or the PO isn't Approved -> nothing.
 *
 * Raw-material shortfall is irrelevant here on purpose: Regulatory can
 * approve a product whose materials are short.
 */
export async function sendItemToRegulatoryIfReady(
  purchaseOrderItemId: string | null | undefined,
  actorId: string,
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  if (!purchaseOrderItemId) return;

  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: purchaseOrderItemId },
    select: {
      id: true,
      productName: true,
      deletedAt: true,
      cancelledAt: true,
      sentToRegulatoryAt: true,
      regulatoryStatus: true,
      planSentToProductionAt: true,
      purchaseOrder: { select: { id: true, poNumber: true, status: true, customer: { select: { companyName: true } } } },
    },
  });
  if (!item || item.deletedAt || item.cancelledAt || item.planSentToProductionAt) return;
  if (item.purchaseOrder.status !== "APPROVED") return;
  if (item.regulatoryStatus === "Approved") return;
  if (item.sentToRegulatoryAt && item.regulatoryStatus !== "Not Approved") return;

  const isResend = item.regulatoryStatus === "Not Approved";
  await prisma.purchaseOrderItem.update({
    where: { id: item.id },
    data: {
      sentToRegulatoryAt: new Date(),
      sentToRegulatoryById: actorId,
      // A re-send after "Not Approved" clears the old decision so it's a
      // fresh Pending review (the old verdict stays in the audit log).
      ...(isResend ? { regulatoryStatus: null, regulatoryRemarks: null, regulatoryReviewedById: null, regulatoryReviewedAt: null } : {}),
    },
  });

  await recordAudit({
    actorId,
    action: isResend ? "purchase_order.item_resent_to_regulatory" : "purchase_order.item_sent_to_regulatory",
    entityType: "PurchaseOrder",
    entityId: item.purchaseOrder.id,
    metadata: { itemId: item.id, automatic: true },
  });

  const poLabel = item.purchaseOrder.poNumber ?? `PO ${item.purchaseOrder.id.slice(0, 8)}`;
  await notifyRoles(
    ["REGULATORY"],
    {
      title: `${isResend ? "Plan re-sent" : "Plan sent"} for regulatory review — ${item.productName}`,
      body: `${item.purchaseOrder.customer.companyName} · ${poLabel} — plan is calculated, needs Regulatory review.`,
      link: `/purchase-orders/${item.purchaseOrder.id}`,
    },
    actorId,
  ).catch((err) => log?.error({ err }, "notify failed: regulatory.plan_sent"));
}
