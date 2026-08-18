import { z } from "zod";

const recipeIngredientSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1),
  costPerKg: z.number().nonnegative(),
  gPerServing: z.number().positive(),
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
        ingredients: z.array(recipeIngredientSchema).min(1),
      }),
    )
    .min(1),
});

export type ImportRecipesInput = z.infer<typeof importRecipesSchema>;
