import { z } from "zod";

export const createVendorSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(60).optional(),
  contactPerson: z.string().max(200).optional(),
  contactNo: z.union([z.string().regex(/^\d{10}$/, "Contact No. must be exactly 10 digits"), z.literal("")]).optional(),
  gstNo: z.string().max(40).optional(),
  email: z.union([z.string().email("Enter a valid email address").max(200), z.literal("")]).optional(),
  address: z.string().max(500).optional(),
});

export const updateVendorSchema = createVendorSchema.partial();

// Bulk upload — one row per vendor, resolved by Name. Unlike Customer's
// import (update-only, never creates), this one creates a vendor the
// first time its name is seen and updates it on every later sheet that
// mentions the same name again — vendor lists come in as a single
// "here's who we deal with" sheet from Purchase, not a diff against an
// existing directory, so create-or-update is the useful default here.
// Deliberately loose (shape only): a malformed cell in one row shouldn't
// 400 the whole sheet — each row is re-validated against
// createVendorSchema individually in the route handler.
const importVendorRowSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(60).optional(),
  contactPerson: z.string().max(200).optional(),
  contactNo: z.string().max(20).optional(),
  gstNo: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
});

export const importVendorsSchema = z.object({
  rows: z.array(importVendorRowSchema).min(1).max(2000),
});

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type ImportVendorsInput = z.infer<typeof importVendorsSchema>;
export type ImportVendorRow = z.infer<typeof importVendorRowSchema>;
