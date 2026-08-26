import { z } from "zod";

const CATEGORIES = ["RM", "PM"] as const;

// Bulk upload — one row per (PO, RM/PM item) pair. A real sheet lists
// 20-40 rows per PO, hundreds of POs at once (see the schema.prisma
// comment on PoMaterialRequirement for the business context). poNumber
// is matched against an existing PurchaseOrder, never created here — a
// requirement has to belong to a PO BD already entered.
export const importPoRequirementsSchema = z.object({
  rows: z
    .array(
      z.object({
        poNumber: z.string().min(1).max(120),
        category: z.enum(CATEGORIES),
        itemName: z.string().min(1).max(200),
        requiredQty: z.coerce.number().positive(),
        unit: z.string().min(1).max(40),
      }),
    )
    .min(1)
    .max(5000),
});

// Manual single-row add — the "Add Manually" form next to the bulk Excel
// upload, same "quick correction/one-off doesn't need a whole sheet"
// reasoning as every other module's manual-entry-plus-bulk-import pair.
// Unlike the bulk import, purchaseOrderId and itemId are real ids here
// (picked from a dropdown, not resolved from free text) — a manual form
// has no reason to accept a typo'd PO number or item name the way a
// pasted-in sheet does.
export const createPoRequirementSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  itemId: z.string().uuid(),
  category: z.enum(CATEGORIES),
  requiredQty: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
});

export type ImportPoRequirementsInput = z.infer<typeof importPoRequirementsSchema>;
export type CreatePoRequirementInput = z.infer<typeof createPoRequirementSchema>;
