import { z } from "zod";

const recipeIngredientSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1),
  // The RM item's own code, when known — see schema.prisma's comment on
  // RecipeIngredient.itemCode.
  itemCode: z.string().max(60).optional(),
  gPerServing: z.number().positive(),
  uom: z.string().max(20).optional(),
  // Accepts either a 0-1 fraction or a 0-100 percentage, same as the
  // prototype's parser (`pVal > 1 ? pVal / 100 : pVal`) — normalized in the route.
  proteinPct: z.number().min(0).default(0),
});

// One recipe ("sheet") with all of its ingredient rows, matching how the
// source workbook is naturally grouped after SheetJS parses it client-side —
// same shape convention as packaging-bom's importCatalogSchema.
export const importRecipesSchema = z.object({
  recipes: z
    .array(
      z.object({
        name: z.string().min(1),
        // The customer this recipe is for. Omitted/null only for an old common recipe.
        customerId: z.string().nullable().optional(),
        // Alternative to customerId, like the packaging catalog import: an exact company-name match is reused, none creates one.
        customerName: z.string().min(1).optional(),
        // PER_KG = quantity per Kg of batch (powder, bar); PER_UNIT = milligrams per gummy / capsule.
        kind: z.enum(["PER_KG", "PER_UNIT"]).optional(),
        productCode: z.string().max(60).nullable().optional(),
        versionLabel: z.string().max(80).nullable().optional(),
        batchSize: z.number().positive().nullable().optional(),
        avgUnitWeightMg: z.number().positive().nullable().optional(),
        note: z.string().max(200).optional(),
        ingredients: z.array(recipeIngredientSchema).min(1),
      }),
    )
    .min(1),
});

export type ImportRecipesInput = z.infer<typeof importRecipesSchema>;
