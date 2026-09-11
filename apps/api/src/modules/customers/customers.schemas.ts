import { z } from "zod";

export const createCustomerSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactPerson: z.string().max(200).optional(),
  // Exactly 10 digits, nothing else — the frontend field also strips
  // non-digit keystrokes and caps at 10 (see FieldGrid's "tel" type), but
  // this is the real enforcement since the API is reachable directly.
  contactNo: z.union([z.string().regex(/^\d{10}$/, "Contact No. must be exactly 10 digits"), z.literal("")]).optional(),
  gstNo: z.string().max(40).optional(),
  email: z.union([z.string().email("Enter a valid email address").max(200), z.literal("")]).optional(),
  deliveryAddress: z.string().max(500).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

// Bulk update — one row per existing customer, resolved by Company Name
// (same technique purchase-orders/import already uses to resolve
// customers). Deliberately loose: only shape is checked here, not the
// phone/email format rules — a malformed cell in one row shouldn't 400
// the whole sheet the way a stricter schema would (validateBody rejects
// the entire array on any row's failure). Each row is re-validated
// against updateCustomerSchema individually in the route handler, so the
// real rules still apply — just per-row, with a per-row result instead
// of an all-or-nothing 400.
const importCustomerUpdateRowSchema = z.object({
  companyName: z.string().min(1).max(200), // matching key — this design has no ID column, never written to
  contactPerson: z.string().max(200).optional(),
  contactNo: z.string().max(20).optional(),
  gstNo: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  deliveryAddress: z.string().max(500).optional(),
});

export const importCustomerUpdatesSchema = z.object({
  rows: z.array(importCustomerUpdateRowSchema).min(1).max(2000),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ImportCustomerUpdatesInput = z.infer<typeof importCustomerUpdatesSchema>;
export type ImportCustomerUpdateRow = z.infer<typeof importCustomerUpdateRowSchema>;
