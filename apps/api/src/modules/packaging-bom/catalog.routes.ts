import { Router } from "express";
import type { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { importCatalogSchema } from "./catalog.schemas";
import type { Prisma } from "@prisma/client";

export const catalogRouter = Router();

catalogRouter.use(requireAuth);

// Any authenticated user can read the catalog — it's reference data, not sensitive.
catalogRouter.get("/brands", async (_req, res, next) => {
  try {
    const brands = await prisma.brand.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { skus: true } } },
    });
    res.json(brands.map((b) => ({ id: b.id, name: b.name, skuCount: b._count.skus })));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/skus", async (req, res, next) => {
  try {
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    const where = brandId ? { brandId } : undefined;
    const pagination = parsePagination(req);
    const [total, skus] = await Promise.all([
      prisma.sku.count({ where }),
      prisma.sku.findMany({
        where,
        include: { brand: true },
        orderBy: [{ brand: { name: "asc" } }, { productName: "asc" }],
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(
      skus.map((s) => ({
        id: s.id,
        brandId: s.brandId,
        brandName: s.brand.name,
        productName: s.productName,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Catalog import/maintenance is restricted to the roles who actually own
// packaging master data — everyone else gets read-only access above.
catalogRouter.post(
  "/import",
  requireRole("PPIC", "PURCHASE"),
  validateBody(importCatalogSchema),
  async (req: AuthedRequest, res, next) => {
    try {
      const { brands } = req.body as z.infer<typeof importCatalogSchema>;

      let brandsTouched = 0;
      let skusUpserted = 0;

      for (const brandInput of brands) {
        const brand = await prisma.brand.upsert({
          where: { name: brandInput.brand },
          create: { name: brandInput.brand },
          update: {},
        });
        brandsTouched += 1;

        for (const sku of brandInput.skus) {
          const { extra, ...specFields } = sku;
          const data = { ...specFields, extra: extra as Prisma.InputJsonValue | undefined };

          await prisma.sku.upsert({
            where: { brandId_productName: { brandId: brand.id, productName: sku.productName } },
            create: { brandId: brand.id, ...data },
            update: { ...data },
          });
          skusUpserted += 1;
        }
      }

      await recordAudit({
        actorId: req.user!.id,
        action: "catalog.imported",
        entityType: "Brand",
        metadata: { brandsTouched, skusUpserted },
      });

      res.status(201).json({ brandsTouched, skusUpserted });
    } catch (err) {
      next(err);
    }
  },
);
