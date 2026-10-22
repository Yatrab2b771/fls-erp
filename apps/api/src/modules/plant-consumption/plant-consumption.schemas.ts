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
    // D - sent as a sample (QC / retention)
    sampleQty: z.coerce.number().nonnegative().default(0),
    // The batch of the run this belongs to (optional - leave out to log it for the run as a whole)
    productionBatchId: z.string().uuid().optional(),
    unit: z.string().min(1).max(40),
    destinationType: z.enum(["DAY_STORE", "WAREHOUSE"]).optional(),
    destDayStoreId: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  })
  .refine((data) => data.consumedQty + data.wastedQty + data.rejectedQty + data.returnedQty + data.sampleQty > 0, {
    message: "Enter at least one quantity greater than zero",
    path: ["consumedQty"],
  })
  // A batch's E · Return is leftover that stays in the Plant's stock (it is sent back to the Day Store later, from Plant Stock): no destination.
  .refine((data) => (data.returnedQty > 0 && !data.productionBatchId ? !!data.destinationType : true), {
    message: "Select where the returned material is going",
    path: ["destinationType"],
  })
  .refine((data) => (data.returnedQty > 0 && !data.productionBatchId && data.destinationType === "DAY_STORE" ? !!data.destDayStoreId : true), {
    message: "Select a destination Store",
    path: ["destDayStoreId"],
  });

export type RecordPlantConsumptionInput = z.infer<typeof recordPlantConsumptionSchema>;
