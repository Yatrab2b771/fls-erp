import { z } from "zod";

const CATEGORIES = ["RM", "PM"] as const;
const TXN_TYPES = ["RECEIVED", "ISSUED_DAY_STORE", "ISSUED_PRODUCTION"] as const;
const DISPATCH_TRANSFER_TYPES = ["FG", "BILL"] as const;

export const createInventoryItemSchema = z.object({
  category: z.enum(CATEGORIES),
  name: z.string().min(1).max(200),
  unit: z.string().max(40).optional(), // Kg | Ltr | Count | other free-text, per the tool's Unit column
});

export const updateInventoryItemSchema = createInventoryItemSchema.omit({ category: true }).partial();

// One "Material Received" / "Material Issued to day store" / "Material
// Issued to Production" row — same field set for all three, `type` picks
// the sheet it belongs to.
export const createInventoryTransactionSchema = z.object({
  itemId: z.string().uuid(),
  type: z.enum(TXN_TYPES),
  date: z.coerce.date(),
  unit: z.string().min(1).max(40),
  quantity: z.coerce.number().positive(),
  size: z.string().max(120).optional(), // Optional, per the tool — e.g. Inch / ft / Kg / Ltr sizing note
  vendorName: z.string().max(200).optional(),
});

// One "FG transfer to Dispatch" / "Bill transfer to Dispatch from Accounts"
// row — same field set for both, `type` picks the sheet it belongs to.
export const createDispatchTransferSchema = z.object({
  type: z.enum(DISPATCH_TRANSFER_TYPES),
  date: z.coerce.date(),
  customerId: z.string().uuid(),
  productName: z.string().min(1).max(200),
  quantity: z.coerce.number().positive(),
});

// Bulk upload of the same "Material Received/Issued" row shape — one
// `type` for the whole batch (the sheet being uploaded), items resolved
// or created by (category, name) same as the single-entry form's "+ New"
// item option.
export const importInventoryTransactionsSchema = z.object({
  type: z.enum(TXN_TYPES),
  rows: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        itemName: z.string().min(1).max(200),
        date: z.coerce.date(),
        unit: z.string().min(1).max(40),
        quantity: z.coerce.number().positive(),
        size: z.string().max(120).optional(),
        vendorName: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type CreateInventoryTransactionInput = z.infer<typeof createInventoryTransactionSchema>;
export type CreateDispatchTransferInput = z.infer<typeof createDispatchTransferSchema>;
export type ImportInventoryTransactionsInput = z.infer<typeof importInventoryTransactionsSchema>;
