import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import {
  createVendorSchema,
  updateVendorSchema,
  importVendorsSchema,
  type CreateVendorInput,
  type UpdateVendorInput,
  type ImportVendorsInput,
} from "./vendors.schemas";

export const vendorsRouter = Router();

vendorsRouter.use(requireAuth);

// Directory read is open to everyone who needs to pick a vendor while
// raising or reviewing a vendor PO — same broad list Pre-Inventory's GET
// already uses; only Purchase/Admin write.
vendorsRouter.get("/", requireRole("PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, vendors] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.findMany({ orderBy: { name: "asc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(vendors);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.get("/:id", requireRole("PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    res.json(vendor);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.post("/", requireRole("PURCHASE"), validateBody(createVendorSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateVendorInput;
    const vendor = await prisma.vendor.create({ data: { ...data, createdById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "vendor.created", entityType: "Vendor", entityId: vendor.id });

    res.status(201).json(vendor);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.patch("/:id", requireRole("PURCHASE"), validateBody(updateVendorSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Vendor not found" });

    const data = req.body as UpdateVendorInput;
    const updated = await prisma.vendor.update({ where: { id: req.params.id }, data });

    await recordAudit({ actorId: req.user!.id, action: "vendor.updated", entityType: "Vendor", entityId: updated.id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Bulk upload — one row per vendor, resolved by Name. Creates a new
// vendor the first time a name is seen, updates it on every later sheet
// mentioning the same name — see vendors.schemas.ts for why this differs
// from Customer's update-only import.
vendorsRouter.post("/import", requireRole("PURCHASE"), validateBody(importVendorsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportVendorsInput;

    const existing = await prisma.vendor.findMany({ select: { id: true, name: true } });
    const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v.id]));

    const results: { row: number; name: string; status: "created" | "updated" | "invalid"; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 1;

      const fieldResult = createVendorSchema.safeParse(row);
      if (!fieldResult.success) {
        results.push({ row: rowNum, name: row.name, status: "invalid", message: fieldResult.error.issues.map((iss) => iss.message).join("; ") });
        continue;
      }

      const key = row.name.trim().toLowerCase();
      const existingId = byName.get(key);
      if (existingId) {
        const updated = await prisma.vendor.update({ where: { id: existingId }, data: fieldResult.data });
        await recordAudit({ actorId: req.user!.id, action: "vendor.updated", entityType: "Vendor", entityId: updated.id, metadata: { source: "bulk_import" } });
        results.push({ row: rowNum, name: updated.name, status: "updated", message: "Updated." });
      } else {
        const created = await prisma.vendor.create({ data: { ...fieldResult.data, createdById: req.user!.id } });
        byName.set(key, created.id);
        await recordAudit({ actorId: req.user!.id, action: "vendor.created", entityType: "Vendor", entityId: created.id, metadata: { source: "bulk_import" } });
        results.push({ row: rowNum, name: created.name, status: "created", message: "Created." });
      }
    }

    res.json({
      rowsProcessed: results.length,
      created: results.filter((r) => r.status === "created").length,
      updated: results.filter((r) => r.status === "updated").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      results,
    });
  } catch (err) {
    next(err);
  }
});
