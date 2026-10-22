import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { writeVersion, type BomKind } from "./bom-version-store";
import { saveRecipe, type RecipeSaveInput } from "../rm-costing/recipe-catalog.routes";

export interface PmHeader {
  productCode?: string | null;
  packSize?: string | null;
  packingConfig?: string | null;
  batchPacks?: number | null;
}
export interface PmComponentSnapshot {
  type: string;
  quantity?: number | null;
  unit: string;
  pmCode?: string | null;
  pmItemId?: string | null;
  overagePct?: number | null;
  spec?: string | null;
  make?: string | null;
  packingLevel?: string | null;
}
export interface PmSnapshot {
  header: PmHeader;
  components: PmComponentSnapshot[];
}

/** Replaces a product's packaging BOM (header + rows) and records it as the next version. */
export async function savePmBom(skuId: string, snapshot: PmSnapshot, note: string | null | undefined, userId: string | null): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const h = snapshot.header;
    await tx.sku.update({
      where: { id: skuId },
      data: {
        ...(h.productCode !== undefined ? { productCode: h.productCode?.trim() || null } : {}),
        ...(h.packSize !== undefined ? { packSize: h.packSize?.trim() || null } : {}),
        ...(h.packingConfig !== undefined ? { packingConfig: h.packingConfig?.trim() || null } : {}),
        ...(h.batchPacks !== undefined ? { batchPacks: h.batchPacks ?? null } : {}),
      },
    });
    await tx.skuPackagingComponent.deleteMany({ where: { skuId } });
    if (snapshot.components.length) {
      await tx.skuPackagingComponent.createMany({
        data: snapshot.components.map((c) => ({
          skuId,
          type: c.type,
          quantity: c.quantity ?? null,
          unit: c.unit || "Nos",
          pmCode: c.pmCode ?? null,
          pmItemId: c.pmItemId ?? null,
          overagePct: c.overagePct ?? null,
          spec: c.spec?.trim() || null,
          make: c.make?.trim() || null,
          packingLevel: c.packingLevel?.trim() || null,
        })),
      });
    }
    const after = await tx.sku.findUniqueOrThrow({ where: { id: skuId }, select: { productCode: true, packSize: true, packingConfig: true, batchPacks: true } });
    return writeVersion(tx, "PM", skuId, { header: after, components: snapshot.components } satisfies PmSnapshot, note, userId);
  });
}

export const bomVersionsRouter = Router();
bomVersionsRouter.use(requireAuth);

function parseKind(v: string): BomKind | null {
  return v === "PM" || v === "RM" ? v : null;
}

// The list of versions of one BOM, newest first. The latest one is the Active one.
bomVersionsRouter.get("/:kind/:entityId", async (req, res, next) => {
  try {
    const kind = parseKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "kind must be PM or RM" });
    const rows = await prisma.bomVersion.findMany({ where: { kind, entityId: req.params.entityId }, orderBy: { version: "desc" } });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    res.json(rows.map((r, i) => ({ version: r.version, note: r.note, createdAt: r.createdAt, createdByName: r.createdById ? nameOf.get(r.createdById) ?? null : null, active: i === 0 })));
  } catch (err) {
    next(err);
  }
});

bomVersionsRouter.get("/:kind/:entityId/:version", async (req, res, next) => {
  try {
    const kind = parseKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "kind must be PM or RM" });
    const row = await prisma.bomVersion.findUnique({ where: { kind_entityId_version: { kind, entityId: req.params.entityId, version: Number(req.params.version) } } });
    if (!row) return res.status(404).json({ error: "Version not found" });
    res.json({ version: row.version, note: row.note, createdAt: row.createdAt, snapshot: row.snapshot });
  } catch (err) {
    next(err);
  }
});

// Makes an old version the live one again - saved as a new version on top, never deleting anything.
bomVersionsRouter.post("/:kind/:entityId/:version/restore", requireRole("RND"), async (req: AuthedRequest<{ kind: string; entityId: string; version: string }>, res, next) => {
  try {
    const kind = parseKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "kind must be PM or RM" });
    const n = Number(req.params.version);
    const row = await prisma.bomVersion.findUnique({ where: { kind_entityId_version: { kind, entityId: req.params.entityId, version: n } } });
    if (!row) return res.status(404).json({ error: "Version not found" });
    const note = `Restored from v${n}`;
    let version: number;
    if (kind === "PM") {
      const sku = await prisma.sku.findUnique({ where: { id: req.params.entityId }, select: { id: true } });
      if (!sku) return res.status(404).json({ error: "Product not found" });
      const snap = row.snapshot as unknown as PmSnapshot;
      // A Warehouse item deleted since the snapshot was taken is dropped from the link, the row stays.
      const ids = [...new Set(snap.components.map((c) => c.pmItemId).filter((x): x is string => !!x))];
      const alive = new Set((await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((i) => i.id));
      version = await savePmBom(sku.id, { header: snap.header, components: snap.components.map((c) => ({ ...c, pmItemId: c.pmItemId && alive.has(c.pmItemId) ? c.pmItemId : null })) }, note, req.user!.id);
    } else {
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.entityId }, select: { name: true, customerId: true } });
      if (!recipe) return res.status(404).json({ error: "Recipe not found" });
      version = await saveRecipe({ ...(row.snapshot as unknown as Omit<RecipeSaveInput, "name">), name: recipe.name, customerId: recipe.customerId }, note, req.user!.id);
    }
    await recordAudit({ actorId: req.user!.id, action: "bom.version_restored", entityType: kind === "PM" ? "Sku" : "Recipe", entityId: req.params.entityId, metadata: { restoredFrom: n, newVersion: version } });
    res.json({ version });
  } catch (err) {
    next(err);
  }
});
