import { z } from "zod";

export const createRecipeRequestSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
});

export const giveEtaSchema = z.object({
  etaDate: z.coerce.date(),
  etaNote: z.string().max(500).optional(),
});

export type CreateRecipeRequestInput = z.infer<typeof createRecipeRequestSchema>;
export type GiveEtaInput = z.infer<typeof giveEtaSchema>;
