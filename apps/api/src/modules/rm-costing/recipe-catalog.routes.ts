import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { importRecipesSchema, type ImportRecipesInput } from "./recipe-catalog.schemas";
import { resolveRmRequests } from "../recipe-requests/recipe-request.routes";

export const recipeCatalogRouter = Router();

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
        // Same "is this a fraction or a percentage" normalization as the
        // prototype's parser: values > 1 are treated as 0-100 percentages.
        const ingredients = recipeInput.ingredients.map((ing, index) => ({
          name: ing.name,
          brand: ing.brand,
          costPerKg: ing.costPerKg,
          gPerServing: ing.gPerServing,
          proteinPct: ing.proteinPct > 1 ? ing.proteinPct / 100 : ing.proteinPct,
          sortOrder: index,
        }));
        const totalServing = ingredients.reduce((sum, ing) => sum + ing.gPerServing, 0);

        await prisma.$transaction(async (tx) => {
          const recipe = await tx.recipe.upsert({
            where: { name: recipeInput.name },
            create: { name: recipeInput.name, totalServing },
            update: { totalServing },
          });
          // Replace the ingredient list wholesale — same "re-upload the sheet"
          // semantics as the prototype (no partial-ingredient edits via import).
          await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
          await tx.recipeIngredient.createMany({
            data: ingredients.map((ing) => ({ ...ing, recipeId: recipe.id })),
          });
        });

        recipesUpserted += 1;
        ingredientsUpserted += ingredients.length;

        // Fulfils any PPIC request that was waiting on exactly this
        // recipe name — see recipe-request.routes.ts.
        await resolveRmRequests(recipeInput.name).catch((err) => req.log?.error({ err }, "resolveRmRequests failed"));
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
