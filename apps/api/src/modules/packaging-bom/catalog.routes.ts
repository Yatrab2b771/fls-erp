import { Router } from "express";
import type { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { importCatalogSchema, createSkuSchema, updateSkuSchema, reportCatalogMismatchSchema, updatePackagingComponentsSchema } from "./catalog.schemas";
import { resolveBomRequests } from "../recipe-requests/recipe-request.routes";
import { notifyRoles } from "../../common/lib/notify";
import type { Prisma, Sku, SkuPackagingComponent } from "@prisma/client";

export const catalogRouter = Router();

catalogRouter.use(requireAuth);

// Full spec, not just the id/name every dropdown wants — this is what
// lets the Catalog Browser show (and edit) the actual packaging spec,
// `extra` included, instead of just a name to pick from.
function serializeSku(s: Sku & { packagingComponents?: SkuPackagingComponent[] }, customerName: string) {
  return {
    id: s.id,
    customerId: s.customerId,
    customerName,
    productName: s.productName,
    jar: s.jar,
    wadMm: s.wadMm,
    scoopMl: s.scoopMl,
    silicaGelGms: s.silicaGelGms,
    silicaGelQtyNos: s.silicaGelQtyNos,
    authenticationSticker: s.authenticationSticker,
    capSticker: s.capSticker,
    capLockSticker: s.capLockSticker,
    neckSleeve: s.neckSleeve,
    shrink: s.shrink,
    innerPackaging: s.innerPackaging,
    leaflet: s.leaflet,
    corrugatedBoxMm: s.corrugatedBoxMm,
    packagingSizeNos: s.packagingSizeNos,
    extra: (s.extra as Record<string, unknown> | null) ?? undefined,
    packagingComponents: (s.packagingComponents ?? []).map((c) => ({ id: c.id, type: c.type, quantity: c.quantity, unit: c.unit, pmCode: c.pmCode })),
  };
}

// Distinct Product Names across the *whole* catalog (every customer), not
// scoped to one — lets BD's "Add Product" picker on the PO form suggest a
// product that already exists under a different customer (e.g. a brand-new
// customer wanting an already-manufactured formulation), instead of only
// ever offering the selected customer's own, empty SKU list. Names only,
// not full SKU rows — a picker just needs the string, and this stays cheap
// even as the catalog grows into the thousands.
catalogRouter.get("/product-names", async (_req, res, next) => {
  try {
    const rows = await prisma.sku.findMany({
      select: { productName: true },
      distinct: ["productName"],
      orderBy: { productName: "asc" },
    });
    res.json(rows.map((r) => r.productName));
  } catch (err) {
    next(err);
  }
});

// Any authenticated user can read the catalog — it's reference data, not
// sensitive. Scoped to one Customer at a time, same as Brand used to be —
// see the Sku model's own comment on why Customer replaced Brand here.
catalogRouter.get("/skus", async (req, res, next) => {
  try {
    const customerId = typeof req.query.customerId === "string" ? req.query.customerId : undefined;
    const where = customerId ? { customerId } : undefined;
    const pagination = parsePagination(req);
    const [total, skus] = await Promise.all([
      prisma.sku.count({ where }),
      prisma.sku.findMany({
        where,
        include: { customer: true, packagingComponents: { orderBy: { type: "asc" } } },
        orderBy: [{ customer: { companyName: "asc" } }, { productName: "asc" }],
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(skus.map((s) => serializeSku(s, s.customer.companyName)));
  } catch (err) {
    next(err);
  }
});

// Quick-add, open to any authenticated user (BD tagging a brand-new
// Product straight off the PO form, against a Customer already picked
// there) — deliberately separate from the full R&D-only Import below.
// Upserted so tagging the same new product twice from two POs never
// errors or duplicates.
catalogRouter.post("/skus", validateBody(createSkuSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { customerId, productName } = req.body as z.infer<typeof createSkuSchema>;
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(400).json({ error: "Unknown customer" });
    const sku = await prisma.sku.upsert({
      where: { customerId_productName: { customerId, productName } },
      create: { customerId, productName },
      update: {},
    });
    // Same gap-check checkGap() uses — a Sku row existing at all is what
    // "bomNeeded" means, regardless of how it got created. Import Catalog
    // already resolves any waiting request on upsert; this one-at-a-time
    // path (BD tagging a new product straight off the PO form, or R&D's
    // own manual "+ Add a product") needs the exact same call, or a
    // request raised before this Sku existed sits stuck forever even
    // though the gate it's waiting on has already closed.
    await resolveBomRequests(customerId, sku.productName).catch((err) => req.log?.error({ err }, "resolveBomRequests failed"));
    res.status(201).json(serializeSku(sku, customer.companyName));
  } catch (err) {
    next(err);
  }
});

// Editing one SKU's own spec by hand — R&D-only, same as the full
// Import below (this is the same "author the catalog" job, just one row
// at a time instead of a whole sheet). Covers both fixing a value Import
// Catalog got wrong and adding/renaming/removing an `extra` field, and
// also fixes the same spelling-mismatch problem as a Customer rename,
// but for a Product Name — e.g. a sheet imported as "Whey Proten" now
// silently mismatches every PO that types "Whey Protein" correctly.
catalogRouter.patch("/skus/:id", requireRole("RND"), validateBody(updateSkuSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as z.infer<typeof updateSkuSchema>;
    const { extra, ...specFields } = data;
    const existing = await prisma.sku.findUnique({ where: { id: req.params.id }, include: { customer: true } });
    if (!existing) return res.status(404).json({ error: "SKU not found" });
    if (specFields.productName && specFields.productName !== existing.productName) {
      const clash = await prisma.sku.findUnique({ where: { customerId_productName: { customerId: existing.customerId, productName: specFields.productName } } });
      if (clash) return res.status(409).json({ error: `"${existing.customer.companyName}" already has a product named "${specFields.productName}" — merge into that one instead of renaming into it.` });
    }
    const sku = await prisma.sku.update({
      where: { id: req.params.id },
      data: { ...specFields, ...(extra !== undefined ? { extra: extra as Prisma.InputJsonValue } : {}) },
      include: { packagingComponents: { orderBy: { type: "asc" } } },
    });
    await recordAudit({ actorId: req.user!.id, action: "catalog.sku_updated", entityType: "Sku", entityId: sku.id });
    // See the same call on POST /skus above — a rename (or any spec
    // edit) is still R&D authoring this Sku, same as an Import row would.
    await resolveBomRequests(existing.customerId, sku.productName).catch((err) => req.log?.error({ err }, "resolveBomRequests failed"));
    res.json(serializeSku(sku, existing.customer.companyName));
  } catch (err) {
    next(err);
  }
});

// The packaging BOM checklist — a full replace, same "caller sends the
// complete list back" rule as `extra`. R&D-only, same authoring rule as
// everything else that authors this catalog by hand.
catalogRouter.put(
  "/skus/:id/packaging-components",
  requireRole("RND"),
  validateBody(updatePackagingComponentsSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const { components } = req.body as z.infer<typeof updatePackagingComponentsSchema>;
      const skuId = req.params.id;
      const existing = await prisma.sku.findUnique({ where: { id: skuId }, include: { customer: true } });
      if (!existing) return res.status(404).json({ error: "SKU not found" });

      await prisma.$transaction([
        prisma.skuPackagingComponent.deleteMany({ where: { skuId } }),
        ...(components.length ? [prisma.skuPackagingComponent.createMany({ data: components.map((c) => ({ ...c, skuId })) })] : []),
      ]);

      await recordAudit({ actorId: req.user!.id, action: "catalog.sku_packaging_updated", entityType: "Sku", entityId: existing.id, metadata: { componentCount: components.length } });

      // See the same call on POST /skus above — this is the real
      // packaging-authoring step for a Sku that already existed (e.g.
      // created bare off the PO form), so it's the most likely place a
      // waiting request actually gets resolved from.
      await resolveBomRequests(existing.customerId, existing.productName).catch((err) => req.log?.error({ err }, "resolveBomRequests failed"));

      const sku = await prisma.sku.findUniqueOrThrow({ where: { id: skuId }, include: { packagingComponents: { orderBy: { type: "asc" } } } });
      res.json(serializeSku(sku, existing.customer.companyName));
    } catch (err) {
      next(err);
    }
  },
);

// BD hit Cancel on the "Did you mean...?" prompt (see findSimilarName.ts
// on the web side) — a real spelling mismatch in the Customer/Product
// directory, not a new duplicate being created. Nothing to write here,
// just tell R&D there's a name worth fixing — R&D would otherwise never
// find out this happened.
catalogRouter.post("/mismatch-reports", validateBody(reportCatalogMismatchSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { kind, typedName, matchedName, customerName } = req.body as z.infer<typeof reportCatalogMismatchSchema>;
    const label = kind === "customer" ? "Customer" : "Product";
    await notifyRoles(
      ["RND"],
      {
        title: `Possible spelling mismatch: "${matchedName}"`,
        body: `BD typed "${typedName}" for a ${label.toLowerCase()}${kind === "product" && customerName ? ` under ${customerName}` : ""} and matched the existing "${matchedName}" instead. If that's a typo, fix it from Packaging BOM → Browse & Edit Catalog.`,
        link: "/packaging-bom",
      },
      req.user!.id,
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Catalog import/maintenance is R&D-only — PPIC used to hold this too,
// but per the client, authoring new packaging formulations is R&D's job
// now: PPIC requests what's missing (see recipe-request.routes.ts),
// R&D delivers it here. Everyone else keeps read-only access above.
//
// Each sheet's name is a Customer's company name, not a separate Brand —
// resolved against the real Customer directory: an exact (case-
// insensitive) match is reused, no match creates a bare Customer (name
// only, same as the PO form's own "+ New"), and more than one match
// (Customer.companyName has no unique constraint) is reported back
// rather than guessed at, same as customers.routes.ts's own bulk-update
// "ambiguous" handling.
catalogRouter.post(
  "/import",
  requireRole("RND"),
  validateBody(importCatalogSchema),
  async (req: AuthedRequest, res, next) => {
    try {
      const { customers } = req.body as z.infer<typeof importCatalogSchema>;

      let customersTouched = 0;
      let skusUpserted = 0;
      const ambiguous: { customerName: string; matchCount: number }[] = [];

      for (const customerInput of customers) {
        const matches = await prisma.customer.findMany({ where: { companyName: { equals: customerInput.customerName, mode: "insensitive" } } });
        let customer: { id: string; companyName: string };
        if (matches.length > 1) {
          ambiguous.push({ customerName: customerInput.customerName, matchCount: matches.length });
          continue;
        } else if (matches.length === 1) {
          customer = matches[0]!;
        } else {
          customer = await prisma.customer.create({ data: { companyName: customerInput.customerName, createdById: req.user!.id } });
        }
        customersTouched += 1;

        for (const sku of customerInput.skus) {
          const { extra, ...specFields } = sku;
          const data = { ...specFields, extra: extra as Prisma.InputJsonValue | undefined };

          await prisma.sku.upsert({
            where: { customerId_productName: { customerId: customer.id, productName: sku.productName } },
            create: { customerId: customer.id, ...data },
            update: { ...data },
          });
          skusUpserted += 1;

          // Fulfils any PPIC request that was waiting on exactly this
          // Customer + product name — see recipe-request.routes.ts.
          await resolveBomRequests(customer.id, sku.productName).catch((err) => req.log?.error({ err }, "resolveBomRequests failed"));
        }
      }

      await recordAudit({
        actorId: req.user!.id,
        action: "catalog.imported",
        entityType: "Customer",
        metadata: { customersTouched, skusUpserted, ambiguous },
      });

      res.status(201).json({ customersTouched, skusUpserted, ambiguous });
    } catch (err) {
      next(err);
    }
  },
);
