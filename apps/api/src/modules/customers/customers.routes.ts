import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { z } from "zod";
import { validateBody } from "../../common/middleware/validate";
import {
  createCustomerSchema,
  updateCustomerSchema,
  importCustomerUpdatesSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type ImportCustomerUpdatesInput,
} from "./customers.schemas";

const top10Schema = z.object({ isTop10: z.boolean() });

export const customersRouter = Router();

customersRouter.use(requireAuth);

// Directory read is open to any authenticated user — everyone in the
// order flow needs to pick a customer; only BD/Admin write.
customersRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const search = parseSearch(req);
    // ?type=New&type=Top 10&type=Others - the customers of any of those types (New: joined in the last 90 days; Top 10: picked by BD; Others: neither)
    const types = (Array.isArray(req.query.type) ? req.query.type : req.query.type ? [req.query.type] : []).filter((v): v is string => typeof v === "string");
    const since = new Date(Date.now() - 90 * 86_400_000);
    const typeWhere = types.length
      ? {
          OR: [
            ...(types.includes("New") ? [{ OR: [{ newOverride: true }, { newOverride: null, createdAt: { gte: since } }] }] : []),
            ...(types.includes("Top 10") ? [{ isTop10: true }] : []),
            ...(types.includes("Others") ? [{ isTop10: false, OR: [{ newOverride: false }, { newOverride: null, createdAt: { lt: since } }] }] : []),
          ],
        }
      : undefined;
    const searchWhere = search
      ? {
          OR: [
            { companyName: { contains: search, mode: "insensitive" as const } },
            { contactPerson: { contains: search, mode: "insensitive" as const } },
            { contactNo: { contains: search, mode: "insensitive" as const } },
            { gstNo: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : undefined;
    const where = typeWhere && searchWhere ? { AND: [typeWhere, searchWhere] } : (typeWhere ?? searchWhere);
    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({ where, orderBy: { companyName: "asc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(customers.map((c) => ({ ...c, isNew: isNewCustomer(c) })));
  } catch (err) {
    next(err);
  }
});

// The tag of every customer: New (joined in the last 90 days, worked out here, never stored) and Top 10 (picked by BD). Both can be true at once;
// neither = Others. Read by every list in the web app to show the pill and to filter by customer type.
const NEW_DAYS = 90;
const isNewCustomer = (c: { createdAt: Date; newOverride: boolean | null }) => c.newOverride ?? c.createdAt.getTime() >= Date.now() - NEW_DAYS * 86_400_000;
customersRouter.get("/tags", async (_req, res, next) => {
  try {
    const customers = await prisma.customer.findMany({ select: { id: true, companyName: true, isTop10: true, createdAt: true, newOverride: true }, orderBy: { companyName: "asc" } });
    res.json(customers.map((c) => ({ id: c.id, companyName: c.companyName, isTop10: c.isTop10, isNew: isNewCustomer(c) })));
  } catch (err) {
    next(err);
  }
});

// The PO form's "Customer type" dropdown: BD tags the customer as New, Top 10 or Others in one pick
const typeSchema = z.object({ type: z.enum(["New", "Top 10", "Others"]) });
customersRouter.patch("/:id/type", requireRole("BD"), validateBody(typeSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, companyName: true } });
    if (!existing) return res.status(404).json({ error: "Customer not found" });
    const { type } = req.body as z.infer<typeof typeSchema>;
    const data = type === "New" ? { isTop10: false, newOverride: true } : type === "Top 10" ? { isTop10: true, newOverride: false } : { isTop10: false, newOverride: false };
    const customer = await prisma.customer.update({ where: { id: existing.id }, data: { ...data, top10SetAt: new Date(), top10SetById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "customer.type_set", entityType: "Customer", entityId: customer.id, metadata: { companyName: existing.companyName, type } });
    res.json({ ...customer, isNew: isNewCustomer(customer) });
  } catch (err) {
    next(err);
  }
});

// BD (and Admin) choose who is in the Top 10: no rule and no limit, their call
customersRouter.patch("/:id/top10", requireRole("BD"), validateBody(top10Schema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, companyName: true } });
    if (!existing) return res.status(404).json({ error: "Customer not found" });
    const { isTop10 } = req.body as { isTop10: boolean };
    const customer = await prisma.customer.update({ where: { id: existing.id }, data: { isTop10, top10SetAt: new Date(), top10SetById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: isTop10 ? "customer.top10_added" : "customer.top10_removed", entityType: "Customer", entityId: customer.id, metadata: { companyName: existing.companyName } });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

customersRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

// R&D can add a customer too (just a name) when authoring a BOM for a brand-new customer.
customersRouter.post("/", requireRole("BD", "RND"), validateBody(createCustomerSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateCustomerInput;
    const customer = await prisma.customer.create({ data: { ...data, createdById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "customer.created", entityType: "Customer", entityId: customer.id });

    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
});

customersRouter.patch("/:id", requireRole("BD"), validateBody(updateCustomerSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const data = req.body as UpdateCustomerInput;
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data });

    await recordAudit({ actorId: req.user!.id, action: "customer.updated", entityType: "Customer", entityId: updated.id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Bulk update — one row per existing customer, resolved by Company Name
// (same technique the PO import already uses to resolve customers, but
// grouped into an array per normalized name rather than collapsed into a
// single id — a shared company name is reported as "ambiguous" instead of
// silently resolving to whichever duplicate was enumerated last, since
// there's no unique constraint on companyName). No row ever renames a
// customer — companyName is only the lookup key here; a real rename still
// goes through PATCH /:id above. A row that doesn't resolve, or fails the
// same field validation PATCH /:id enforces, is reported and skipped —
// the rest of the sheet still goes through.
customersRouter.post("/import-updates", requireRole("BD"), validateBody(importCustomerUpdatesSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportCustomerUpdatesInput;

    const allCustomers = await prisma.customer.findMany({ select: { id: true, companyName: true } });
    const byName = new Map<string, { id: string; companyName: string }[]>();
    for (const c of allCustomers) {
      const key = c.companyName.trim().toLowerCase();
      const arr = byName.get(key);
      if (arr) arr.push(c);
      else byName.set(key, [c]);
    }

    const results: { row: number; companyName: string; status: "updated" | "unmatched" | "ambiguous" | "invalid"; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 1;

      const key = row.companyName.trim().toLowerCase();
      const candidates = byName.get(key) ?? [];
      if (candidates.length === 0) {
        results.push({ row: rowNum, companyName: row.companyName, status: "unmatched", message: `No customer found named "${row.companyName}".` });
        continue;
      }
      if (candidates.length > 1) {
        results.push({
          row: rowNum,
          companyName: row.companyName,
          status: "ambiguous",
          message: `${candidates.length} customers are named "${row.companyName}" — edit them individually to tell them apart.`,
        });
        continue;
      }

      // Re-run the same strict per-field rules PATCH /:id already
      // enforces — the loose row schema above only checked shape, so one
      // bad phone/email doesn't 400 the whole sheet, but a row that
      // resolves to a real customer still can't write bad data.
      const { companyName: _companyName, ...fields } = row;
      const fieldResult = updateCustomerSchema.safeParse(fields);
      if (!fieldResult.success) {
        results.push({ row: rowNum, companyName: row.companyName, status: "invalid", message: fieldResult.error.issues.map((iss) => iss.message).join("; ") });
        continue;
      }

      const updated = await prisma.customer.update({ where: { id: candidates[0]!.id }, data: fieldResult.data });
      await recordAudit({ actorId: req.user!.id, action: "customer.updated", entityType: "Customer", entityId: updated.id, metadata: { source: "bulk_import" } });
      results.push({ row: rowNum, companyName: updated.companyName, status: "updated", message: "Updated." });
    }

    res.json({
      rowsProcessed: results.length,
      updated: results.filter((r) => r.status === "updated").length,
      unmatched: results.filter((r) => r.status === "unmatched").length,
      ambiguous: results.filter((r) => r.status === "ambiguous").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      results,
    });
  } catch (err) {
    next(err);
  }
});
