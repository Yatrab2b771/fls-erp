import { z } from "zod";

const dateField = z.coerce.date().optional();
// FSSAI/AYUSH are the two the form suggests, but a PO can be tagged
// against any regulatory body — free text, not a closed enum, so a new
// one (state-specific, export-market, ...) isn't rejected outright. The
// Prisma column itself is a plain String for the same reason.
const regulatoryBodyField = z.string().max(60).optional();
const REGULATORY_STATUSES = ["Applied", "Not Applied", "Issued"] as const;
const PRODUCT_TYPES = ["EXISTING", "NEW"] as const;

export const purchaseOrderItemSchema = z.object({
  productName: z.string().min(1).max(200),
  dosageForm: z.string().max(120).optional(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40), // KG | SKU | other free-text, per the intake form's "Unit" field
  volume: z.coerce.number().positive().optional(),
  packSize: z.string().max(120).optional(),
  packType: z.string().max(120).optional(),
  bomRef: z.string().max(200).optional(),
  // Defaults to EXISTING — a bulk-imported row or any caller that
  // doesn't set this explicitly keeps today's behavior. The manual PO
  // form makes this a required choice; the schema itself stays lenient
  // so imports don't need updating just for this.
  productType: z.enum(PRODUCT_TYPES).default("EXISTING"),
});

// PO header + at least one product line item — the "Add More" repeating
// list the real intake form needs, submitted together on create.
export const createPurchaseOrderSchema = z.object({
  customerId: z.string().uuid(),
  poNumber: z.string().max(120).optional(),
  orderDate: dateField,
  expectedDeliveryDate: dateField,
  regulatoryBody: regulatoryBodyField,
  regulatoryStatus: z.enum(REGULATORY_STATUSES).optional(),
  items: z.array(purchaseOrderItemSchema).min(1, "A PO needs at least one product line item"),
});

export const updatePurchaseOrderSchema = createPurchaseOrderSchema.omit({ customerId: true, items: true }).partial();

export const updatePurchaseOrderItemSchema = purchaseOrderItemSchema.partial();

// BD Approve/Reject — the one review action a Draft PO gets before it's
// forwarded to PPIC/RM to release and plan against. A reason is required
// on reject, same "don't bounce it back silently" rule the Batch pipeline
// uses for REJECT.
export const reviewPurchaseOrderSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    rejectionReason: z.string().max(1000).optional(),
  })
  .refine((data) => data.status !== "REJECTED" || !!data.rejectionReason?.trim(), {
    message: "A reason is required when rejecting a purchase order",
    path: ["rejectionReason"],
  });

// Bulk upload — BD's own PO system export, one row per (PO, product)
// pair, same shape the rest of the app's bulk imports use. Unlike the
// manual form, poNumber and customerName are both required here:
// poNumber is the only thing that groups several rows into one PO (a
// real sheet lists every product line separately), and customerName is
// resolved-or-created by name — BD already has standalone authority to
// create customers by hand, so doing it inline here on a name match
// isn't a new permission, just the same one exercised through a
// different door.
export const importPurchaseOrdersSchema = z.object({
  rows: z
    .array(
      z.object({
        poNumber: z.string().min(1).max(120),
        customerName: z.string().min(1).max(200),
        orderDate: dateField,
        expectedDeliveryDate: dateField,
        regulatoryBody: regulatoryBodyField,
        regulatoryStatus: z.enum(REGULATORY_STATUSES).optional(),
        productName: z.string().min(1).max(200),
        dosageForm: z.string().max(120).optional(),
        quantity: z.coerce.number().positive(),
        unit: z.string().min(1).max(40),
        volume: z.coerce.number().positive().optional(),
        packSize: z.string().max(120).optional(),
        packType: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

// Generating the PO-level invoice — both fields optional so Accounts can
// preview/save the computed total first and fill in the paperwork
// numbers after, same "not everything has to be typed up front" pattern
// as the Batch stage forms.
export const generatePoInvoiceSchema = z.object({
  invoiceNo: z.string().max(120).optional(),
  invoiceDate: dateField,
});

export type PurchaseOrderItemInput = z.infer<typeof purchaseOrderItemSchema>;
export type GeneratePoInvoiceInput = z.infer<typeof generatePoInvoiceSchema>;
export type ImportPurchaseOrdersInput = z.infer<typeof importPurchaseOrdersSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;
export type UpdatePurchaseOrderItemInput = z.infer<typeof updatePurchaseOrderItemSchema>;
export type ReviewPurchaseOrderInput = z.infer<typeof reviewPurchaseOrderSchema>;
