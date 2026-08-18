import { z } from "zod";

// Same fields/defaults as the prototype's costing panel
// (cost-mfg-loss, cost-pack-size, ... cost-gst inputs).
export const costingParamsSchema = z.object({
  mfgLossPct: z.number().min(0).default(3),
  packSizeG: z.number().positive().default(400),
  testCost: z.number().nonnegative().default(2000),
  jarCost: z.number().nonnegative().default(25),
  scoopCost: z.number().nonnegative().default(8),
  labelCost: z.number().nonnegative().default(23),
  convCost: z.number().nonnegative().default(25),
  ccbCost: z.number().nonnegative().default(8),
  profitPct: z.number().min(0).default(10),
  gstPct: z.number().min(0).default(0),
});

export const createRmPlanSchema = z.object({
  name: z.string().min(1).max(160),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  costingParams: costingParamsSchema.optional(),
  // Optional — links this plan to the specific PO product it's costing
  // formulation for, so Order Tracking can show it inline.
  purchaseOrderItemId: z.string().uuid().optional(),
});

export const addRmPlanItemSchema = z.object({
  recipeId: z.string().uuid(),
  batchSizeKg: z.number().positive(),
});

export const updateCostingParamsSchema = z.object({
  costingParams: costingParamsSchema,
});

export type CostingParamsInput = z.infer<typeof costingParamsSchema>;
export type CreateRmPlanInput = z.infer<typeof createRmPlanSchema>;
export type AddRmPlanItemInput = z.infer<typeof addRmPlanItemSchema>;
