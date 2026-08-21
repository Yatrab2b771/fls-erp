import { z } from "zod";

const CATEGORIES = ["RM", "PM"] as const;

// S1 — PPIC states a requirement: what item, how much, by when.
export const createRequirementSchema = z.object({
  date: z.coerce.date(),
  category: z.enum(CATEGORIES),
  itemId: z.string().uuid(),
  unit: z.string().min(1).max(40),
  requiredQty: z.coerce.number().positive(),
  size: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

// Bulk upload of requirement rows — same resolve-or-create-item pattern
// as the rest of the Inventory module's imports.
export const importRequirementsSchema = z.object({
  rows: z
    .array(
      z.object({
        date: z.coerce.date(),
        category: z.enum(CATEGORIES),
        itemName: z.string().min(1).max(200),
        unit: z.string().min(1).max(40),
        requiredQty: z.coerce.number().positive(),
        size: z.string().max(120).optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

// S2 ("what's already available") isn't a manual step any more — it's
// read live off the existing stock ledger every time a requirement is
// fetched (see pre-inventory.routes.ts). No schema needed for it.

// S3 — Purchase logs what it did about a shortfall. All three together,
// same as the single manual form has no reason to save one without the
// others.
export const setPurchaseSchema = z.object({
  poNumber: z.string().min(1).max(100),
  vendorName: z.string().min(1).max(200),
  eta: z.coerce.date(),
});

export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
export type ImportRequirementsInput = z.infer<typeof importRequirementsSchema>;
export type SetPurchaseInput = z.infer<typeof setPurchaseSchema>;
