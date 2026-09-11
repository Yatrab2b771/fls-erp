import { z } from "zod";

// The known, typed packaging-spec fields — shared by the bulk Import
// below and the single-SKU update further down, so a field added to one
// never silently drifts from the other.
const skuSpecFields = {
  jar: z.string().optional(),
  wadMm: z.string().optional(),
  scoopMl: z.string().optional(),
  silicaGelGms: z.string().optional(),
  silicaGelQtyNos: z.string().optional(),
  authenticationSticker: z.string().optional(),
  capSticker: z.string().optional(),
  capLockSticker: z.string().optional(),
  neckSleeve: z.string().optional(),
  shrink: z.string().optional(),
  innerPackaging: z.string().optional(),
  leaflet: z.string().optional(),
  corrugatedBoxMm: z.string().optional(),
  packagingSizeNos: z.string().optional(),
};

const skuSpecSchema = z.object({
  productName: z.string().min(1),
  ...skuSpecFields,
  // Anything else the imported sheet had, so nothing is silently dropped.
  extra: z.record(z.string(), z.unknown()).optional(),
});

// One Customer ("sheet") with all of its SKU rows, matching how the
// source workbook is naturally grouped after SheetJS parses it
// client-side. There used to be a separate "Brand" grouping here — see
// the Sku model's own comment on why that merged into Customer.
// `customerName` is resolved server-side against the real Customer
// directory (exact match reused, no match creates a bare one, more than
// one match is reported back rather than guessed at — Customer.companyName
// has no unique constraint, unlike Brand.name used to).
export const importCatalogSchema = z.object({
  customers: z
    .array(
      z.object({
        customerName: z.string().min(1),
        skus: z.array(skuSpecSchema).min(1),
      }),
    )
    .min(1),
});

export type ImportCatalogInput = z.infer<typeof importCatalogSchema>;

export const createSkuSchema = z.object({
  customerId: z.string().min(1),
  productName: z.string().min(1),
});
export type CreateSkuInput = z.infer<typeof createSkuSchema>;

// Editing one SKU's own spec straight from the app — the same typed
// fields Import Catalog fills in, plus `extra` for anything that came in
// under a column name this catalog doesn't have a real field for yet (a
// brand-new column in the sheet, or one added by hand here). `extra` is
// a full replace, not a merge — the caller always sends the complete
// object back (see the Catalog Browser's own SkuEditor), so a removed
// custom field actually goes away instead of surviving forever.
export const updateSkuSchema = z.object({
  productName: z.string().min(1).optional(),
  ...skuSpecFields,
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSkuInput = z.infer<typeof updateSkuSchema>;

// BD hit Cancel on the "Did you mean...?" prompt — confirming a real
// spelling mismatch exists in the Customer/Product directory, not
// creating a duplicate. This just tells R&D there's a name to go clean
// up (Customer rename lives on customers.routes.ts, Sku rename below);
// it isn't itself the fix.
export const reportCatalogMismatchSchema = z.object({
  kind: z.enum(["customer", "product"]),
  typedName: z.string().min(1),
  matchedName: z.string().min(1),
  customerName: z.string().optional(), // for kind "product" — which customer this product belongs to
});
export type ReportCatalogMismatchInput = z.infer<typeof reportCatalogMismatchSchema>;

// The real per-product packaging BOM checklist — see SkuPackagingComponent's
// own schema comment for why this is a list instead of more fixed fields.
// Always a full replace, same "caller sends the complete list back" rule
// as `extra` above — a component the caller stops sending is gone, not
// left behind from before.
export const updatePackagingComponentsSchema = z.object({
  components: z.array(
    z.object({
      type: z.string().min(1),
      quantity: z.number().nonnegative().nullable().optional(),
      unit: z.string().min(1).default("Nos"),
      pmCode: z.string().optional(),
    }),
  ),
});
export type UpdatePackagingComponentsInput = z.infer<typeof updatePackagingComponentsSchema>;
