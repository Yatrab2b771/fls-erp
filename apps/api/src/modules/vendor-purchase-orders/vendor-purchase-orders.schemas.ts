import { z } from "zod";

const dateField = z.coerce.date().optional();

// `amount` is deliberately absent here — it's computed server-side from
// quantity/rate/gstPct at write time (GST-exclusive: amount = qty * rate *
// (1 + gstPct/100)), never trusted from the client. See
// vendor-purchase-orders.routes.ts's `computeItemAmount`.
export const vendorPurchaseOrderItemInputSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  rate: z.coerce.number().nonnegative(),
  gstPct: z.coerce.number().min(0).max(100),
});

export const createVendorPurchaseOrderSchema = z.object({
  vendorId: z.string().uuid(),
  poNumber: z.string().min(1).max(120),
  orderDate: z.coerce.date(),
  eta: dateField,
  items: z.array(vendorPurchaseOrderItemInputSchema).min(1, "A vendor PO needs at least one line item"),
});

export const updateVendorPurchaseOrderSchema = createVendorPurchaseOrderSchema.omit({ items: true }).partial();
export const updateVendorPurchaseOrderItemSchema = vendorPurchaseOrderItemInputSchema.partial();

// Warehouse "Mark Received" against one line item — deliberately doesn't
// re-collect quantity/rate/GST (those are Purchase's own field, entered
// at Phase 3); this only carries what a GRN adds at the receiving dock.
// Rides the exact same InventoryTransaction(type: RECEIVED) shape and
// inward QC gate as the existing Material Received flow (see
// inventory.routes.ts POST /transactions) — quantity here is how much
// physically arrived, which may be less than the line's ordered qty
// (partial delivery) and is received across multiple calls if so.
export const receiveVendorPurchaseOrderItemSchema = z.object({
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40).optional(),
  batchNo: z.string().max(100).optional(),
  grnNo: z.string().max(100).optional(),
  mfgDate: dateField,
  expiryDate: dateField,
  remark: z.string().max(500).optional(),
});

export const addVendorPurchaseOrderFreightSchema = z.object({
  freightCharges: z.coerce.number().nonnegative(),
});

export type VendorPurchaseOrderItemInput = z.infer<typeof vendorPurchaseOrderItemInputSchema>;
export type CreateVendorPurchaseOrderInput = z.infer<typeof createVendorPurchaseOrderSchema>;
export type UpdateVendorPurchaseOrderInput = z.infer<typeof updateVendorPurchaseOrderSchema>;
export type UpdateVendorPurchaseOrderItemInput = z.infer<typeof updateVendorPurchaseOrderItemSchema>;
export type ReceiveVendorPurchaseOrderItemInput = z.infer<typeof receiveVendorPurchaseOrderItemSchema>;
export type AddVendorPurchaseOrderFreightInput = z.infer<typeof addVendorPurchaseOrderFreightSchema>;
