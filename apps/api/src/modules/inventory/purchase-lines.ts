import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";

/**
 * Purchase splits one shortfall into several PI lines ("20 + 40 + 40 Kg", each with its
 * own PI Number / Vendor / ETA). These helpers are the single place that decides
 * how much of a shortfall is still to be logged, and that closes lines as stock arrives.
 */

export const QTY_EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Db = Prisma.TransactionClient | typeof prisma;

export interface LineQty {
  quantity: number;
  receivedQty: number;
  status: "OPEN" | "RECEIVED";
}

/** What is still to arrive on a line (0 once it is received). */
export function openQtyOf(line: LineQty): number {
  return line.status === "OPEN" ? Math.max(0, line.quantity - line.receivedQty) : 0;
}

/**
 * Against the live shortfall: `onOrderQty` is how much of it is covered by lines that
 * have not arrived yet (never more than the shortfall - stock that arrived another way
 * shrinks the shortfall too), `remainingToLog` is what Purchase can still log.
 */
export function summarizeLines(lines: LineQty[], shortQty: number): { openQty: number; onOrderQty: number; remainingToLog: number } {
  const openQty = lines.reduce((sum, l) => sum + openQtyOf(l), 0);
  const short = Math.max(0, shortQty);
  return { openQty: round2(openQty), onOrderQty: round2(Math.min(openQty, short)), remainingToLog: round2(Math.max(0, short - openQty)) };
}

/**
 * Keeps the requirement's own poNumber / vendorName / eta / purchaseAt in step with its
 * lines (the most recently logged one), for everything that still reads those columns -
 * the dashboard's PI Logged count, vendor suggestions, the "can't delete once logged" rule.
 */
export async function syncRequirementSummary(requirementId: string, db: Db = prisma): Promise<void> {
  const lines = await db.requirementPurchaseLine.findMany({ where: { requirementId }, orderBy: { loggedAt: "desc" } });
  const latest = lines[0];
  const corrected = lines.map((l) => l.correctedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  await db.preInventoryRequirement.update({
    where: { id: requirementId },
    data: latest
      ? { poNumber: latest.piNumber, vendorName: latest.vendorName, eta: latest.eta, purchaseById: latest.loggedById, purchaseAt: latest.loggedAt, purchaseCorrectedAt: corrected }
      : { poNumber: null, vendorName: null, eta: null, purchaseById: null, purchaseAt: null, purchaseCorrectedAt: null },
  });
}

/**
 * Stock of `itemId` just arrived (`qty` accepted into stock): close the open lines for
 * that item, earliest ETA first, so the same quantity is not counted both as stock and
 * as "still on order".
 */
export async function allocateReceiptToPurchaseLines(itemId: string, qty: number, db: Db = prisma, vendorName?: string | null): Promise<void> {
  let left = qty;
  if (left <= QTY_EPS) return;
  const found = await db.requirementPurchaseLine.findMany({
    where: { status: "OPEN", requirement: { itemId, deletedAt: null } },
    orderBy: [{ eta: "asc" }, { loggedAt: "asc" }],
  });
  // A delivery closes the lines Purchase ordered from THAT vendor first (earliest ETA first); only what is left over goes to other
  // vendors' lines for the same item. Otherwise vendor A's delivery would tick off vendor B's order.
  const same = (l: { vendorName: string }) => !!vendorName && l.vendorName.trim().toLowerCase() === vendorName.trim().toLowerCase();
  const lines = [...found.filter(same), ...found.filter((l) => !same(l))];
  for (const line of lines) {
    if (left <= QTY_EPS) break;
    const take = Math.min(left, openQtyOf(line));
    if (take <= 0) continue;
    const receivedQty = round2(line.receivedQty + take);
    const done = receivedQty >= line.quantity - QTY_EPS;
    await db.requirementPurchaseLine.update({ where: { id: line.id }, data: { receivedQty, ...(done ? { status: "RECEIVED", closedAt: new Date() } : {}) } });
    left = round2(left - take);
  }
}
