import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import {
  createCustomerSchema,
  updateCustomerSchema,
  importCustomerUpdatesSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type ImportCustomerUpdatesInput,
} from "./customers.schemas";

export const customersRouter = Router();

customersRouter.use(requireAuth);

// Directory read is open to any authenticated user — everyone in the
// order flow needs to pick a customer; only BD/Admin write.
customersRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, customers] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.findMany({ orderBy: { companyName: "asc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(customers);
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

customersRouter.post("/", requireRole("BD"), validateBody(createCustomerSchema), async (req: AuthedRequest, res, next) => {
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
