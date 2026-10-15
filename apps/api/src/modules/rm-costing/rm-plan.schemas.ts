import { z } from "zod";

export const createRmPlanSchema = z.object({
  name: z.string().min(1).max(160),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  // Optional — links this plan to the specific PO product it's costing
  // formulation for, so Order Tracking can show it inline.
  purchaseOrderItemId: z.string().uuid().optional(),
});

export const addRmPlanItemSchema = z.object({
  recipeId: z.string().uuid(),
  batchSizeKg: z.number().positive(),
});

export type CreateRmPlanInput = z.infer<typeof createRmPlanSchema>;
export type AddRmPlanItemInput = z.infer<typeof addRmPlanItemSchema>;
