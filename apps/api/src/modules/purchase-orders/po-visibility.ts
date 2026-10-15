import type { Prisma, RoleName } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";

// A PO only becomes real for the rest of the company once BD approves it —
// Draft (still being entered/checked) and Rejected POs are BD's own working
// state, so only BD and Admin get to see them. Every other department
// (PPIC, Regulatory, Production, Store, ...) only ever sees Approved POs.
// Enforced here on the server, not just hidden in the UI, so a direct link
// or a report can't leak an unapproved PO either.
export function canSeeUnapprovedPos(roles: RoleName[] | undefined): boolean {
  return !!roles && (roles.includes("BD") || roles.includes("ADMIN"));
}

/** `where` fragment for PurchaseOrder queries — spread/merge into an existing filter. */
export function poVisibilityWhere(roles: RoleName[] | undefined): Prisma.PurchaseOrderWhereInput {
  return canSeeUnapprovedPos(roles) ? {} : { status: "APPROVED" };
}

/** True when the PO that owns this line item has been approved by BD — planning off a Draft/Rejected PO is blocked. */
export async function isPoItemApproved(purchaseOrderItemId: string): Promise<boolean> {
  const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { purchaseOrder: { select: { status: true } } } });
  return item?.purchaseOrder.status === "APPROVED";
}
