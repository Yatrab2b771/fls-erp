import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { loadIncoming } from "../inventory/pre-inventory.routes";

/**
 * Vendor payments - Finance (Accounts) only.
 *
 *   GET  /payments                          the RM / PM that are short and that Purchase has logged a vendor, PO number and ETA for, one row per
 *                                           purchase line, with what Finance has decided on it (no decision yet = Pending)
 *   POST /lines/:lineId/payment             pay part or all of it (the amount; Partial or Full), with an optional remark
 *   POST /lines/:lineId/hold                put it on hold (remark needed)
 *   POST /lines/:lineId/reject              reject it (remark needed)
 *
 * Every action stamps the remark time: Finance's aging counts from the last remark (or, before any, from when Purchase logged the line).
 * Purchase is told about each decision.
 */
export const financeRouter = Router();
financeRouter.use(requireAuth);
const ACCOUNTS_ONLY = requireRole("ACCOUNTS");

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const daysSince = (d: Date) => Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS));

const decisionInclude = { payments: { orderBy: { paidOn: "asc" as const } }, updatedBy: { select: { fullName: true } } };

export async function loadFinanceRows() {
  const incoming = await loadIncoming();
  const decisions = await prisma.financeDecision.findMany({ where: { purchaseLineId: { in: incoming.map((r) => r.lineId) } }, include: decisionInclude });
  const byLine = new Map(decisions.map((d) => [d.purchaseLineId, d]));
  return incoming.map((r) => {
    const d = byLine.get(r.lineId);
    const paidTotal = round2((d?.payments ?? []).reduce((sum, p) => sum + p.amount, 0));
    const waitingSince = d ? d.remarksAt : r.loggedAt;
    return {
      lineId: r.lineId,
      piNumber: r.piNumber,
      vendorName: r.vendorName,
      eta: r.eta,
      overdue: r.overdue,
      itemName: r.itemName,
      category: r.category,
      unit: r.unit,
      shortQty: r.shortQty,
      orderedQty: r.orderedQty,
      customerPo: r.customerPo ? { poNumber: r.customerPo.poNumber, productName: r.customerPo.productName, customerName: r.customerPo.customerName } : null,
      status: (d?.status ?? "PENDING") as "PENDING" | "PAID_PARTIAL" | "PAID_FULL" | "ON_HOLD" | "REJECTED",
      poAmount: d?.poAmount ?? null,
      paidTotal,
      balance: d?.poAmount != null ? round2(Math.max(0, d.poAmount - paidTotal)) : null,
      remarks: d?.remarks ?? null,
      remarksAt: d?.remarksAt ?? null,
      updatedBy: d?.updatedBy.fullName ?? null,
      loggedAt: r.loggedAt,
      waitingDays: daysSince(waitingSince), // Finance's aging: since Purchase logged it, or since Finance's last remark
      payments: (d?.payments ?? []).map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn, remark: p.remark })),
    };
  });
}

// Purchase can read the list (to see what Finance has paid, held or rejected) but only Accounts decides.
financeRouter.get("/payments", requireRole("ACCOUNTS", "PURCHASE"), async (_req, res, next) => {
  try {
    res.json(await loadFinanceRows());
  } catch (err) {
    next(err);
  }
});

async function loadLine(lineId: string) {
  const line = await prisma.requirementPurchaseLine.findFirst({ where: { id: lineId, requirement: { deletedAt: null } }, include: { requirement: { include: { item: true } } } });
  return line;
}

const amountField = z.coerce.number().positive("Enter the amount.");
const paymentSchema = z.object({
  kind: z.enum(["PARTIAL", "FULL"]),
  amount: amountField,
  poAmount: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().positive().optional()),
  paidOn: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.date().optional()),
  remark: z.string().trim().max(500).optional(),
});
const remarkSchema = z.object({ remark: z.string().trim().min(1, "Write the remark.").max(500) });

async function tellPurchase(title: string, body: string, actorId: string) {
  await notifyRoles(["PURCHASE"], { title, body, link: "/pre-inventory" }, actorId).catch(() => {});
}

financeRouter.post("/lines/:lineId/payment", ACCOUNTS_ONLY, validateBody(paymentSchema), async (req: AuthedRequest<{ lineId: string }>, res, next) => {
  try {
    const line = await loadLine(req.params.lineId);
    if (!line) return res.status(404).json({ error: "Purchase line not found" });
    const input = req.body as z.infer<typeof paymentSchema>;
    const existing = await prisma.financeDecision.findUnique({ where: { purchaseLineId: line.id }, include: { payments: true } });
    const poAmount = input.poAmount ?? existing?.poAmount ?? undefined;
    const paidBefore = (existing?.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
    const paidTotal = paidBefore + input.amount;
    const full = input.kind === "FULL" || (poAmount !== undefined && paidTotal >= poAmount - 0.005);
    const decision = await prisma.financeDecision.upsert({
      where: { purchaseLineId: line.id },
      create: { purchaseLineId: line.id, status: full ? "PAID_FULL" : "PAID_PARTIAL", poAmount, remarks: input.remark, updatedById: req.user!.id, payments: { create: { amount: input.amount, paidOn: input.paidOn ?? new Date(), remark: input.remark, createdById: req.user!.id } } },
      update: { status: full ? "PAID_FULL" : "PAID_PARTIAL", poAmount, remarks: input.remark ?? existing?.remarks, remarksAt: new Date(), updatedById: req.user!.id, payments: { create: { amount: input.amount, paidOn: input.paidOn ?? new Date(), remark: input.remark, createdById: req.user!.id } } },
      include: decisionInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "finance.payment", entityType: "RequirementPurchaseLine", entityId: line.id, metadata: { amount: input.amount, kind: input.kind, status: decision.status } });
    await tellPurchase(`Finance ${full ? "paid in full" : "paid part of"}: ${line.requirement.item.name}`, `${line.vendorName} (${line.piNumber}): ${input.amount}${input.remark ? ` - ${input.remark}` : ""}`, req.user!.id);
    res.status(201).json({ status: decision.status, paidTotal: round2(paidTotal) });
  } catch (err) {
    next(err);
  }
});

for (const [path, status, label] of [
  ["hold", "ON_HOLD", "put on hold"],
  ["reject", "REJECTED", "rejected"],
] as const) {
  financeRouter.post(`/lines/:lineId/${path}`, ACCOUNTS_ONLY, validateBody(remarkSchema), async (req: AuthedRequest<{ lineId: string }>, res, next) => {
    try {
      const line = await loadLine(req.params.lineId);
      if (!line) return res.status(404).json({ error: "Purchase line not found" });
      const { remark } = req.body as z.infer<typeof remarkSchema>;
      const decision = await prisma.financeDecision.upsert({
        where: { purchaseLineId: line.id },
        create: { purchaseLineId: line.id, status, remarks: remark, updatedById: req.user!.id },
        update: { status, remarks: remark, remarksAt: new Date(), updatedById: req.user!.id },
      });
      await recordAudit({ actorId: req.user!.id, action: `finance.${path}`, entityType: "RequirementPurchaseLine", entityId: line.id, metadata: { remark } });
      await tellPurchase(`Finance ${label}: ${line.requirement.item.name}`, `${line.vendorName} (${line.piNumber}) - ${remark}`, req.user!.id);
      res.json({ status: decision.status });
    } catch (err) {
      next(err);
    }
  });
}
