import { z } from "zod";

// Source is a Day Store (the original, still the common case) or a Plant
// (Phase 6 — Plant returning unused RM/PM to a store/Warehouse). Exactly
// one of sourceDayStoreId/sourcePlantId must be set, matching sourceType;
// same for destDayStoreId/destPlantId matching destinationType (both
// null means WAREHOUSE). A Plant source can't target another Plant — a
// return goes back to a store or the Warehouse, never plant-to-plant.
export const createStockTransferSchema = z
  .object({
    itemId: z.string().uuid(),
    quantity: z.coerce.number().positive(),
    unit: z.string().min(1).max(40),
    note: z.string().max(500).optional(),
    sourceType: z.enum(["DAY_STORE", "PLANT"]).default("DAY_STORE"),
    sourceDayStoreId: z.string().uuid().optional(),
    sourcePlantId: z.string().uuid().optional(),
    destinationType: z.enum(["DAY_STORE", "WAREHOUSE", "PLANT"]),
    destDayStoreId: z.string().uuid().optional(),
    destPlantId: z.string().uuid().optional(),
  })
  .refine((data) => (data.sourceType === "DAY_STORE" ? !!data.sourceDayStoreId && !data.sourcePlantId : true), {
    message: "Select a source Day Store",
    path: ["sourceDayStoreId"],
  })
  .refine((data) => (data.sourceType === "PLANT" ? !!data.sourcePlantId && !data.sourceDayStoreId : true), {
    message: "Select a source Plant",
    path: ["sourcePlantId"],
  })
  .refine((data) => (data.sourceType === "PLANT" ? data.destinationType !== "PLANT" : true), {
    message: "A Plant-to-Plant transfer isn't supported — a Plant return goes to a store or the Warehouse",
    path: ["destinationType"],
  })
  .refine((data) => (data.destinationType === "DAY_STORE" ? !!data.destDayStoreId && !data.destPlantId : true), {
    message: "Select a destination Day Store",
    path: ["destDayStoreId"],
  })
  .refine((data) => (data.destinationType === "PLANT" ? !!data.destPlantId && !data.destDayStoreId : true), {
    message: "Select a destination Plant",
    path: ["destPlantId"],
  })
  .refine((data) => (data.destinationType === "WAREHOUSE" ? !data.destDayStoreId && !data.destPlantId : true), {
    message: "A Warehouse destination doesn't take a Day Store or Plant",
    path: ["destinationType"],
  })
  .refine((data) => !(data.sourceType === "DAY_STORE" && data.destinationType === "DAY_STORE" && data.destDayStoreId === data.sourceDayStoreId), {
    message: "Source and destination can't be the same Day Store",
    path: ["destDayStoreId"],
  });

export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;
