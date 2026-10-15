import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { importRecipesSchema, type ImportRecipesInput } from "./recipe-catalog.schemas";
import { resolveRmRequests } from "../recipe-requests/recipe-request.routes";
import { writeVersion } from "../packaging-bom/bom-version-store";

export const recipeCatalogRouter = Router();

export type RecipeSaveInput = ImportRecipesInput["recipes"][number];

/** Creates or replaces one recipe by name and records the result as its next version. Returns the version number. */
export async function saveRecipe(recipeInput: RecipeSaveInput, note: string | null | undefined, userId: string | null): Promise<number> {
  // Same "is this a fraction or a percentage" normalization as the prototype's parser: values > 1 are 0-100 percentages.
  const ingredients = recipeInput.ingredients.map((ing, index) => ({
    name: ing.name,
    brand: ing.brand,
    itemCode: ing.itemCode,
    costPerKg: 0, // the system does no costing; the column is kept only for old data
    gPerServing: ing.gPerServing,
    proteinPct: ing.proteinPct > 1 ? ing.proteinPct / 100 : ing.proteinPct,
    uom: ing.uom?.trim() || (recipeInput.kind === "PER_UNIT" ? "mg" : "Kg"),
    sortOrder: index,
  }));
  const totalServing = ingredients.reduce((sum, ing) => sum + ing.gPerServing, 0);
  const header = {
    ...(recipeInput.kind ? { kind: recipeInput.kind } : {}),
    ...(recipeInput.productCode !== undefined ? { productCode: recipeInput.productCode?.trim() || null } : {}),
    ...(recipeInput.versionLabel !== undefined ? { versionLabel: recipeInput.versionLabel?.trim() || null } : {}),
    ...(recipeInput.batchSize !== undefined ? { batchSize: recipeInput.batchSize } : {}),
    ...(recipeInput.avgUnitWeightMg !== undefined ? { avgUnitWeightMg: recipeInput.avgUnitWeightMg } : {}),
  };
  const customerId = recipeInput.customerId ?? null;
  return prisma.$transaction(async (tx) => {
    // One recipe per customer + product name (a null customer = the old common recipe of that name).
    const existing = await tx.recipe.findFirst({ where: { customerId, name: { equals: recipeInput.name, mode: "insensitive" } } });
    const recipe = existing
      ? await tx.recipe.update({ where: { id: existing.id }, data: { totalServing, ...header } })
      : await tx.recipe.create({ data: { name: recipeInput.name, customerId, totalServing, ...header } });
    // Replace the ingredient list wholesale - same "re-upload the sheet" semantics as the prototype.
    await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
    await tx.recipeIngredient.createMany({ data: ingredients.map((ing) => ({ ...ing, recipeId: recipe.id })) });
    const snapshot = {
      kind: recipe.kind,
      productCode: recipe.productCode,
      versionLabel: recipe.versionLabel,
      batchSize: recipe.batchSize,
      avgUnitWeightMg: recipe.avgUnitWeightMg,
      ingredients: recipeInput.ingredients,
    };
    return writeVersion(tx, "RM", recipe.id, snapshot, note ?? recipeInput.note, userId);
  });
}

recipeCatalogRouter.use(requireAuth);

// Any authenticated user can read the recipe catalog — it's reference data
// for costing/planning, not sensitive on its own.
recipeCatalogRouter.get("/recipes", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, recipes] = await Promise.all([
      prisma.recipe.count(),
      prisma.recipe.findMany({
        orderBy: { name: "asc" },
        include: { _count: { select: { ingredients: true } } },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(
      recipes.map((r) => ({
        id: r.id,
        name: r.name,
        totalServing: r.totalServing,
        customerId: r.customerId,
        kind: r.kind,
        productCode: r.productCode,
        ingredientCount: r._count.ingredients,
      })),
    );
  } catch (err) {
    next(err);
  }
});

recipeCatalogRouter.get("/recipes/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const recipe = await prisma.recipe.findUnique({
      where: { id: req.params.id },
      include: { ingredients: { orderBy: { sortOrder: "asc" } } },
    });
    if (!recipe) return res.status(404).json({ error: "Recipe not found" });
    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

// Import/maintenance is R&D-only — PPIC used to own this, but per the
// client, authoring new formulations is R&D's job now: PPIC requests
// what's missing (see recipe-request.routes.ts), R&D delivers it here.
// Everyone else keeps read-only access above.
recipeCatalogRouter.post(
  "/recipes/import",
  requireRole("RND"),
  validateBody(importRecipesSchema),
  async (req: AuthedRequest, res, next) => {
    try {
      const { recipes } = req.body as ImportRecipesInput;

      let recipesUpserted = 0;
      let ingredientsUpserted = 0;

      for (const recipeInput of recipes) {
        if (!recipeInput.customerId && recipeInput.customerName) {
          const matches = await prisma.customer.findMany({ where: { companyName: { equals: recipeInput.customerName, mode: "insensitive" } }, select: { id: true } });
          if (matches.length > 1) return res.status(409).json({ error: `More than one customer is called "${recipeInput.customerName}" - pick the customer by id.` });
          recipeInput.customerId = matches[0]?.id ?? (await prisma.customer.create({ data: { companyName: recipeInput.customerName, createdById: req.user!.id } })).id;
        }
        if (recipeInput.customerId && !(await prisma.customer.findUnique({ where: { id: recipeInput.customerId }, select: { id: true } }))) {
          return res.status(400).json({ error: "Unknown customer" });
        }
        const ingredientCount = recipeInput.ingredients.length;
        await saveRecipe(recipeInput, undefined, req.user!.id);

        recipesUpserted += 1;
        ingredientsUpserted += ingredientCount;

        // Fulfils any PPIC request that was waiting on exactly this
        // recipe name — see recipe-request.routes.ts.
        await resolveRmRequests(recipeInput.name, recipeInput.customerId ?? null, req.user!.id).catch((err) => req.log?.error({ err }, "resolveRmRequests failed"));
      }

      await recordAudit({
        actorId: req.user!.id,
        action: "recipe_catalog.imported",
        entityType: "Recipe",
        metadata: { recipesUpserted, ingredientsUpserted },
      });

      res.status(201).json({ recipesUpserted, ingredientsUpserted });
    } catch (err) {
      next(err);
    }
  },
);
