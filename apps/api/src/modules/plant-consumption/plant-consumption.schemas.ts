import { z } from "zod";

// One entry per RM/PM item, per PreProduction run: however much of
// consumed/wasted/rejected/returned Plant actually saw for that item.
// All four default to 0 so a caller only fills in what applies; at least
// one must be positive. Returned material goes through the same
// StockTransfer sender-creates/receiver-confirms lifecycle as any other
// transfer (see stock-transfers.routes.ts) — destinationType/
// destDayStoreId are only required when returnedQty > 0.
export const recordPlantConsumptionSchema = z
  .object({
    itemId: z.string().uuid(),
    consumedQty: z.coerce.number().nonnegative().default(0),
    wastedQty: z.coerce.number().nonnegative().default(0),
    rejectedQty: z.coerce.number().nonnegative().default(0),
    returnedQty: z.coerce.number().nonnegative().default(0),
    unit: z.string().min(1).max(40),
    destinationType: z.enum(["DAY_STORE", "WAREHOUSE"]).optional(),
    destDayStoreId: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  })
  .refine((data) => data.consumedQty + data.wastedQty + data.rejectedQty + data.returnedQty > 0, {
    message: "Enter at least one quantity greater than zero",
    path: ["consumedQty"],
  })
  .refine((data) => (data.returnedQty > 0 ? !!data.destinationType : true), {
    message: "Select where the returned material is going",
    path: ["destinationType"],
  })
  .refine((data) => (data.returnedQty > 0 && data.destinationType === "DAY_STORE" ? !!data.destDayStoreId : true), {
    message: "Select a destination Day Store",
    path: ["destDayStoreId"],
  });

export type RecordPlantConsumptionInput = z.infer<typeof recordPlantConsumptionSchema>;
