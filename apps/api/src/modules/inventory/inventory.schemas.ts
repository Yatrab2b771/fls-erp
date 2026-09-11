import { z } from "zod";

const CATEGORIES = ["RM", "PM"] as const;
const TXN_TYPES = ["RECEIVED", "ISSUED_DAY_STORE", "ISSUED_PRODUCTION"] as const;
const DISPATCH_TRANSFER_TYPES = ["FG", "BILL"] as const;
// A request's purpose is never RECEIVED — receiving stock isn't something
// a department "requests", it's what Store logs when it arrives.
const REQUEST_PURPOSES = ["ISSUED_DAY_STORE", "ISSUED_PRODUCTION"] as const;

export const createInventoryItemSchema = z.object({
  category: z.enum(CATEGORIES),
  name: z.string().min(1).max(200),
  unit: z.string().max(40).optional(), // Kg | Ltr | Count | other free-text, per the tool's Unit column
  code: z.string().max(60).optional(), // the item master's own code (e.g. "RM00951"), when known
  preferredVendor: z.string().max(200).optional(), // a default suggestion only — see the schema.prisma comment
});

export const updateInventoryItemSchema = createInventoryItemSchema.omit({ category: true }).partial();

// Pricing/costing — matches the client's own stock-report format (Cost
// Price, M.R.P., Purchase Price, Sales Price), separate from
// updateInventoryItemSchema above since it's Purchase/Accounts-only —
// see inventory.routes.ts's PATCH /items/:id/pricing and
// schema.prisma's comment on these fields.
export const updateInventoryItemPricingSchema = z.object({
  costPrice: z.coerce.number().nonnegative().optional().nullable(),
  mrp: z.coerce.number().nonnegative().optional().nullable(),
  purchasePrice: z.coerce.number().nonnegative().optional().nullable(),
  salesPrice: z.coerce.number().nonnegative().optional().nullable(),
});

// Debit Note Issue — the ERP Diagram doc's incoming-QC reject branch,
// raised by Accounts against a RECEIVED row that's come back
// QC_REJECTED (or partially rejected). quantity/unit default to the
// rejected portion client-side but are still explicit here — Accounts
// might debit a different figure than the raw rejected qty (e.g. a
// negotiated partial credit).
export const createDebitNoteSchema = z.object({
  debitNoteNo: z.string().max(120).optional(),
  date: z.coerce.date().optional(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  amount: z.coerce.number().nonnegative().optional(),
  reason: z.string().max(1000).optional(),
});

// --- Item Master import ("SKU Namkaran") — a one-time (or periodic)
// naming-reconciliation upload: real code, plus every name a different
// department calls this item by, resolved down to one standardized
// `name` every other module's exact (category, name) lookup can then
// actually match. Doesn't touch stock — this only authors the item
// catalog itself, same "reference data, not a transaction" shape as
// createInventoryItemSchema above. ---

export const importItemMasterSchema = z.object({
  rows: z
    .array(
      z.object({
        code: z.string().min(1).max(60),
        category: z.enum(CATEGORIES),
        // The standardized name to seed/attach to this item — Correct
        // Name when the sheet has one; the row is rejected only if every
        // one of these three is blank (nothing to name the item at all).
        correctName: z.string().max(200).optional(),
        labName: z.string().max(200).optional(),
        storeName: z.string().max(200).optional(),
        // The sheet's "Make" column — a default vendor suggestion only,
        // never a fixed part of the item the way RecipeIngredient.brand
        // is for a formulation. Blank leaves any existing value alone
        // (doesn't clear it) — a re-run of an older, Make-less version
        // of the sheet shouldn't wipe out a value a newer row elsewhere
        // already set.
        make: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

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
  // S6 — which Day Store received this, ISSUED_DAY_STORE rows only.
  dayStoreId: z.string().uuid().optional(),
  // One-time go-live migration flag — RECEIVED rows only. Skips inward
  // QC entirely (see schema.prisma comment on InventoryTransaction).
  isOpeningStock: z.boolean().optional(),
  // Transit tracking — ISSUED_DAY_STORE/ISSUED_PRODUCTION rows only (see
  // schema.prisma comment on InventoryTransaction). When set, this entry
  // doesn't count as arrived at its destination until someone there
  // calls POST /transactions/:id/confirm-delivery.
  isTransitTracked: z.boolean().optional(),
  // Traceability off the physical stock sheet — batch/GRN/mfg/expiry —
  // all optional, any transaction type (a batch can matter on an issue
  // too, not just on receipt).
  batchNo: z.string().max(100).optional(),
  grnNo: z.string().max(100).optional(),
  mfgDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date().optional(),
  remark: z.string().max(500).optional(),
});

// Editing an existing transaction — deliberately narrow: only the
// descriptive paperwork fields (a GRN number that wasn't available yet
// when Store first logged the delivery is the common case), never
// itemId/type/date/quantity/unit/dayStoreId/plantId. Those drive stock
// math and QC state directly — changing them after the fact would mean
// silently rewriting a number PO Readiness/Pre-Inventory/QC may have
// already acted on. No QC-status restriction either: a GRN No. showing
// up after acceptance is normal, not a reason to block the edit.
export const updateInventoryTransactionSchema = z
  .object({
    batchNo: z.string().max(100).optional(),
    grnNo: z.string().max(100).optional(),
    mfgDate: z.coerce.date().optional(),
    expiryDate: z.coerce.date().optional(),
    vendorName: z.string().max(200).optional(),
    size: z.string().max(120).optional(),
    remark: z.string().max(500).optional(),
  })
  .refine((v) => Object.values(v).some((val) => val !== undefined), { message: "Provide at least one field to update" });

// One "FG transfer to Dispatch" / "Bill transfer to Dispatch from Accounts"
// row — same field set for both, `type` picks the sheet it belongs to.
// sourceRequestId is a manual traceability tag (FG rows only, enforced
// in the route) — not derived, Production isn't tracked here.
export const createDispatchTransferSchema = z.object({
  type: z.enum(DISPATCH_TRANSFER_TYPES),
  date: z.coerce.date(),
  customerId: z.string().uuid(),
  productName: z.string().min(1).max(200),
  quantity: z.coerce.number().positive(),
  sourceRequestId: z.string().uuid().optional(),
  // S8 — which Plant this FG shipment came from, FG rows only.
  plantId: z.string().uuid().optional(),
});

// S9 — Dispatch confirms the shipment has actually gone out.
export const dispatchConfirmSchema = z.object({
  dispatchNote: z.string().max(300).optional(),
});

// S9 — Finance (Accounts) closes the loop once the invoice is raised.
export const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1).max(100),
});

// Bulk upload of the same "Material Received/Issued" row shape — one
// `type` for the whole batch (the sheet being uploaded), items resolved
// or created by (category, name) same as the single-entry form's "+ New"
// item option.
export const importInventoryTransactionsSchema = z.object({
  type: z.enum(TXN_TYPES),
  // One-time go-live migration flag — applies to the whole sheet, not
  // per row (a single upload is either Sanjay's opening-stock snapshot
  // or it isn't). RECEIVED only, enforced at the route.
  isOpeningStock: z.boolean().optional(),
  // Which Day Store this sheet's stock belongs to when the sheet doesn't
  // carry its own per-row Day Store column — a default for the batch,
  // same as picking it once on the manual Log Entry form's dropdown.
  // Any row with its own dayStoreName overrides this. ISSUED_DAY_STORE
  // only, enforced at the route.
  dayStoreId: z.string().uuid().optional(),
  // Transit tracking — applies to the whole sheet, same as isOpeningStock
  // above. ISSUED_DAY_STORE only, enforced at the route (a bulk sheet has
  // no per-row Plant column to gate ISSUED_PRODUCTION rows against
  // anyway — those never come through this import, see the route).
  isTransitTracked: z.boolean().optional(),
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
        // Per-row Day Store, by name — lets one sheet mix rows for
        // several stores (e.g. the app's own downloaded report shape,
        // which has a Day Store column per row). Resolved/created by
        // name server-side, same pattern as itemName. Falls back to the
        // batch-level dayStoreId above when a row omits it.
        dayStoreName: z.string().max(200).optional(),
        // Same per-row traceability fields as a single manual entry —
        // a real sheet mixes items with different batches/expiries, so
        // these live per row, not once for the whole upload.
        batchNo: z.string().max(100).optional(),
        grnNo: z.string().max(100).optional(),
        mfgDate: z.coerce.date().optional(),
        expiryDate: z.coerce.date().optional(),
        remark: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

// Bulk upload of dispatch transfers — unlike items, customers are NOT
// resolved-or-created here: customer creation is BD-only (see
// customers.routes.ts), so Store can't spin up new ones through this
// import. A row whose customerName doesn't match an existing customer
// is skipped and reported back, not auto-created.
export const importDispatchTransfersSchema = z.object({
  type: z.enum(DISPATCH_TRANSFER_TYPES),
  rows: z
    .array(
      z.object({
        customerName: z.string().min(1).max(200),
        date: z.coerce.date(),
        productName: z.string().min(1).max(200),
        quantity: z.coerce.number().positive(),
      }),
    )
    .min(1)
    .max(1000),
});

// --- Material Requests (indents) — the department-wise gate: PPIC raises
// one of these before Store can decide what actually gets issued to
// Production (or Day Store). Mirrors PurchaseOrder's Draft → Approve/
// Reject shape, plus a third terminal step (Issued) once Store fulfills it. ---

export const createInventoryRequestSchema = z.object({
  itemId: z.string().uuid(),
  category: z.enum(CATEGORIES),
  requestedQty: z.coerce.number().positive(),
  purpose: z.enum(REQUEST_PURPOSES),
  neededBy: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  // S7 — which Plant this is for, purpose ISSUED_PRODUCTION only.
  plantId: z.string().uuid().optional(),
});

// Bulk upload of Material Requests — same resolve-or-create-item pattern
// as importInventoryTransactionsSchema, but purpose is a per-row column
// (not one setting for the whole sheet) since a real indent sheet mixes
// Production and Day Store lines naturally.
export const importInventoryRequestsSchema = z.object({
  rows: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        itemName: z.string().min(1).max(200),
        requestedQty: z.coerce.number().positive(),
        purpose: z.enum(REQUEST_PURPOSES),
        neededBy: z.coerce.date().optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const reviewInventoryRequestSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT"]),
    rejectionReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.action !== "REJECT" || !!v.rejectionReason, { message: "A rejection reason is required", path: ["rejectionReason"] });

// What Store actually issued against an approved request — quantity is
// separate from requestedQty so a partial issue is honest about what
// left the shelf, not just an echo of what was asked for.
export const issueInventoryRequestSchema = z.object({
  date: z.coerce.date(),
  unit: z.string().min(1).max(40),
  quantity: z.coerce.number().positive(),
  size: z.string().max(120).optional(),
  // Which Day Store this is coming out of — required (not optional) so
  // real-time per-store balance (stock.ts getOnHandByDayStore) stays
  // trustworthy. An omitted field used to silently mean "came from
  // central stock," indistinguishable from Store simply forgetting to
  // tag it. Now the choice must be explicit: null means central/
  // Warehouse stock on purpose, a uuid means a specific Day Store — the
  // key itself is required either way.
  dayStoreId: z.string().uuid().nullable(),
  // Transit tracking — this fulfillment doesn't count as arrived at its
  // destination (that Day Store, or the request's Plant) until confirmed.
  // See createInventoryTransactionSchema's own isTransitTracked.
  isTransitTracked: z.boolean().optional(),
});

// POST /transactions/:id/confirm-delivery — no required fields, this is
// purely "I received it, right now, as me." Optional note in case
// something's worth recording about the actual handoff (condition,
// partial mismatch noticed on arrival, etc.) — appended onto the row's
// existing remark, not a new column.
export const confirmDeliverySchema = z.object({
  note: z.string().max(500).optional(),
});

// --- Quality Check gates — QA/QC checks, Store/Dispatch acts on the
// result. HOLD parks the entry without a final call either way (QC comes
// back to it later); REJECT is the only terminal outcome. Both HOLD and
// REJECT require a note — same "why" requirement as rejecting a Material
// Request, and Hold arguably needs it even more since "parked" isn't
// self-explanatory the way "rejected" is. ---

export const qcReviewSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT", "HOLD"]),
    note: z.string().max(500).optional(),
  })
  .refine((v) => (v.action !== "REJECT" && v.action !== "HOLD") || !!v.note, { message: "A note is required when rejecting or holding QC", path: ["note"] });

// Inward QC — same three-option gate as outward QC below (Approve,
// Reject, or Hold). Used to also accept a partial-rejection quantity on
// Approve (e.g. 5 of 50 Kg damaged, the rest still clears); that split
// was dropped — QC is a clean call, not a quantity negotiation, so this
// now just aliases the plain schema.
export const inwardQcReviewSchema = qcReviewSchema;

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type UpdateInventoryItemPricingInput = z.infer<typeof updateInventoryItemPricingSchema>;
export type CreateDebitNoteInput = z.infer<typeof createDebitNoteSchema>;
export type ImportItemMasterInput = z.infer<typeof importItemMasterSchema>;
export type CreateInventoryTransactionInput = z.infer<typeof createInventoryTransactionSchema>;
export type UpdateInventoryTransactionInput = z.infer<typeof updateInventoryTransactionSchema>;
export type CreateDispatchTransferInput = z.infer<typeof createDispatchTransferSchema>;
export type ImportDispatchTransfersInput = z.infer<typeof importDispatchTransfersSchema>;
export type ImportInventoryTransactionsInput = z.infer<typeof importInventoryTransactionsSchema>;
export type CreateInventoryRequestInput = z.infer<typeof createInventoryRequestSchema>;
export type ImportInventoryRequestsInput = z.infer<typeof importInventoryRequestsSchema>;
export type ReviewInventoryRequestInput = z.infer<typeof reviewInventoryRequestSchema>;
export type IssueInventoryRequestInput = z.infer<typeof issueInventoryRequestSchema>;
export type QcReviewInput = z.infer<typeof qcReviewSchema>;
export type InwardQcReviewInput = z.infer<typeof inwardQcReviewSchema>;
export type DispatchConfirmInput = z.infer<typeof dispatchConfirmSchema>;
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;
export type InvoiceInput = z.infer<typeof invoiceSchema>;
