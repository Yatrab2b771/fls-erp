import { z } from "zod";

const CATEGORIES = ["RM", "PM"] as const;
const TXN_TYPES = ["RECEIVED", "ISSUED"] as const;

export const createInventoryItemSchema = z.object({
  category: z.enum(CATEGORIES),
  name: z.string().min(1).max(200),
  unit: z.string().max(40).optional(), // Kg | Ltr | Count | other free-text, per the tool's Unit column
});

export const updateInventoryItemSchema = createInventoryItemSchema.omit({ category: true }).partial();

// One "Material Received" / "Material Issued to day store" row — same
// field set for both directions, `type` picks the sheet it belongs to.
export const createInventoryTransactionSchema = z.object({
  itemId: z.string().uuid(),
  type: z.enum(TXN_TYPES),
  date: z.coerce.date(),
  unit: z.string().min(1).max(40),
  quantity: z.coerce.number().positive(),
  size: z.string().max(120).optional(), // Optional, per the tool — e.g. Inch / ft / Kg / Ltr sizing note
  vendorName: z.string().max(200).optional(),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type CreateInventoryTransactionInput = z.infer<typeof createInventoryTransactionSchema>;
