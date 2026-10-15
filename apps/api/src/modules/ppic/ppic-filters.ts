import type { Request } from "express";
import type { Prisma } from "@prisma/client";

/**
 * The filter bar every PPIC tile shares. Values arrive as repeated query keys
 * (?customer=Acme&customer=Zen) - picked from a dropdown, so they are matched
 * exactly; a comma inside a name is therefore never a problem.
 */
export interface TileFilters {
  dateFrom?: string;
  dateTo?: string;
  po: string[];
  customer: string[];
  category: string[];
  product: string[];
  // Material Planning only: "SHORT:RM", "COVERED:PM", ... (a material row's status and type).
  mat: string[];
  // Each tile's own pick (only the tile that offers it sends it).
  plant: string[]; // In Production
  regBody: string[]; // Pending POs
  status: string[]; // Total POs: Draft / Approved / Rejected
  sent: string[]; // Total Products: Sent / Not Sent
  stage: string[]; // Total Products: the product's stage (names as in ITEM_STAGE_LABEL)
  pending: string[]; // Not Planned: RM / BOM (which plan is still missing)
  regulatory: string[]; // PO Readiness: Approved / Not Approved / Pending / Not Sent
  // Aging buckets ("0-7 days" ...): how long the row has been in the tile's list.
  aging: string[];
}

export interface DateRange {
  gt?: Date;
  gte?: Date;
  lte?: Date;
}

const DAY_MS = 86_400_000;

// Aging bucket -> [from, to] whole days (to = null: no upper limit). Keys are the labels the dropdown shows.
const AGING_BUCKETS: Record<string, [number, number | null]> = {
  "0-7 days": [0, 7],
  "8-15 days": [8, 15],
  "16-30 days": [16, 30],
  "31-60 days": [31, 60],
  "60+ days": [61, null],
};

/**
 * The picked Aging buckets as "since" date ranges (a row aged d whole days has
 * since in (now-(d+1) days, now-d days]). Undefined when no bucket is picked;
 * several buckets are OR-ed by the callers.
 */
export function agingRanges(f: TileFilters, now = new Date()): DateRange[] | undefined {
  const ranges = f.aging.flatMap((label) => {
    const bucket = AGING_BUCKETS[label];
    if (!bucket) return [];
    const [from, to] = bucket;
    return [{ ...(to !== null ? { gt: new Date(now.getTime() - (to + 1) * DAY_MS) } : {}), lte: new Date(now.getTime() - from * DAY_MS) }];
  });
  return ranges.length ? ranges : undefined;
}

/** In-memory twin of agingRanges: is `iso` inside any of the picked buckets (true when none is picked)? */
export function inAnyRange(iso: string | null | undefined, ranges: DateRange[] | undefined): boolean {
  if (!ranges) return true;
  return ranges.some((r) => inRange(iso, r));
}

function many(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return [...new Set(list.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))].slice(0, 500);
}

const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export function readFilters(req: Request): TileFilters {
  const q = req.query;
  return { dateFrom: isoDay(q.dateFrom), dateTo: isoDay(q.dateTo), po: many(q.po), customer: many(q.customer), category: many(q.category), product: many(q.product), mat: many(q.mat),
    plant: many(q.plant),
    regBody: many(q.regBody),
    status: many(q.status),
    sent: many(q.sent),
    stage: many(q.stage),
    pending: many(q.pending),
    regulatory: many(q.regulatory),
    aging: many(q.aging),
  };
}

/** The picked From / To dates as an inclusive timestamp range (To runs to the end of that day). */
export function dateRange(f: TileFilters): DateRange | undefined {
  if (!f.dateFrom && !f.dateTo) return undefined;
  return { ...(f.dateFrom ? { gte: new Date(`${f.dateFrom}T00:00:00.000Z`) } : {}), ...(f.dateTo ? { lte: new Date(`${f.dateTo}T23:59:59.999Z`) } : {}) };
}

/** A PO's "since" date: when BD approved it, falling back to its order date, then to when it was entered. */
export function approvalDateWhere(range: DateRange): Prisma.PurchaseOrderWhereInput {
  return { OR: [{ reviewedAt: range }, { reviewedAt: null, orderDate: range }, { reviewedAt: null, orderDate: null, createdAt: range }] };
}

/** PO number / customer picks, for a PO-level list. */
export function poLevelWhere(f: TileFilters): Prisma.PurchaseOrderWhereInput[] {
  const statuses = f.status.map((s) => s.toUpperCase()).filter((s): s is "DRAFT" | "APPROVED" | "REJECTED" => ["DRAFT", "APPROVED", "REJECTED"].includes(s));
  return [
    ...(f.po.length ? [{ poNumber: { in: f.po } }] : []),
    ...(f.customer.length ? [{ customer: { companyName: { in: f.customer } } }] : []),
    ...(f.status.length ? [{ status: { in: statuses } }] : []),
  ];
}

/** PO number / customer / category / product picks, for a product-level list. */
export function itemLevelWhere(f: TileFilters): Prisma.PurchaseOrderItemWhereInput[] {
  return [
    ...(f.po.length ? [{ purchaseOrder: { poNumber: { in: f.po } } }] : []),
    ...(f.customer.length ? [{ purchaseOrder: { customer: { companyName: { in: f.customer } } } }] : []),
    ...(f.category.length ? [{ productCategory: { in: f.category } }] : []),
    ...(f.product.length ? [{ productName: { in: f.product } }] : []),
    ...(f.plant.length ? [{ plannedPlant: { name: { in: f.plant } } }] : []),
    ...(f.regBody.length ? [{ purchaseOrder: { regulatoryBody: { in: f.regBody } } }] : []),
    // Both "Sent" and "Not Sent" picked = no restriction.
    ...(f.sent.length === 1 ? [{ planSentToProductionAt: f.sent[0] === "Sent" ? { not: null } : null }] : []),
    // Still missing the RM plan and/or the packaging BOM plan.
    ...(f.pending.length
      ? [{ OR: [...(f.pending.includes("RM") ? [{ rmPlans: { none: { status: "CALCULATED" as const } } }] : []), ...(f.pending.includes("BOM") ? [{ bomPlans: { none: { status: "CALCULATED" as const } } }] : [])] }]
      : []),
  ];
}

/** The same picks, for lists already held in memory (Material Planning, PO Readiness). */
export function regulatoryLabel(p: { regulatoryStatus: string | null; sentToRegulatoryAt: string | null }): string {
  if (p.regulatoryStatus === "Approved") return "Approved";
  if (p.regulatoryStatus === "Not Approved") return "Not Approved";
  return p.sentToRegulatoryAt ? "Pending" : "Not Sent";
}

export function productMatches(
  p: { poNumber: string | null; customerName: string; productCategory: string | null; productName: string; regulatoryStatus?: string | null; sentToRegulatoryAt?: string | null },
  f: TileFilters,
): boolean {
  return (
    (!f.po.length || (p.poNumber !== null && f.po.includes(p.poNumber))) &&
    (!f.customer.length || f.customer.includes(p.customerName)) &&
    (!f.category.length || (p.productCategory !== null && f.category.includes(p.productCategory))) &&
    (!f.product.length || f.product.includes(p.productName)) &&
    (!f.regulatory.length || f.regulatory.includes(regulatoryLabel({ regulatoryStatus: p.regulatoryStatus ?? null, sentToRegulatoryAt: p.sentToRegulatoryAt ?? null })))
  );
}

export function inRange(iso: string | null | undefined, range: DateRange | undefined): boolean {
  if (!range) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return (!range.gt || t > range.gt.getTime()) && (!range.gte || t >= range.gte.getTime()) && (!range.lte || t <= range.lte.getTime());
}
