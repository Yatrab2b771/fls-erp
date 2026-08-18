import { z } from "zod";

export const createPlanSchema = z.object({
  name: z.string().min(1).max(160),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  // Optional — links this plan to the specific PO product it's packaging
  // for, so Order Tracking can show it inline.
  purchaseOrderItemId: z.string().uuid().optional(),
});

export const addPlanItemSchema = z.object({
  skuId: z.string().uuid(),
  targetYield: z.number().int().positive(),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type AddPlanItemInput = z.infer<typeof addPlanItemSchema>;
