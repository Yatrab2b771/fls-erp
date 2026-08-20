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
// sourceRequestId is a manual traceability tag (FG rows only, enforced
// in the route) — not derived, Production isn't tracked here.
export const createDispatchTransferSchema = z.object({
  type: z.enum(DISPATCH_TRANSFER_TYPES),
  date: z.coerce.date(),
  customerId: z.string().uuid(),
  productName: z.string().min(1).max(200),
  quantity: z.coerce.number().positive(),
  sourceRequestId: z.string().uuid().optional(),
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
});

// --- Quality Check gates — QA/QC checks, Store/Dispatch acts on the
// result. Reject requires a note both times, same "why" requirement as
// rejecting a Material Request. ---

export const qcReviewSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT"]),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.action !== "REJECT" || !!v.note, { message: "A note is required when rejecting QC", path: ["note"] });

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type CreateInventoryTransactionInput = z.infer<typeof createInventoryTransactionSchema>;
export type CreateDispatchTransferInput = z.infer<typeof createDispatchTransferSchema>;
export type ImportDispatchTransfersInput = z.infer<typeof importDispatchTransfersSchema>;
export type ImportInventoryTransactionsInput = z.infer<typeof importInventoryTransactionsSchema>;
export type CreateInventoryRequestInput = z.infer<typeof createInventoryRequestSchema>;
export type ImportInventoryRequestsInput = z.infer<typeof importInventoryRequestsSchema>;
export type ReviewInventoryRequestInput = z.infer<typeof reviewInventoryRequestSchema>;
export type IssueInventoryRequestInput = z.infer<typeof issueInventoryRequestSchema>;
export type QcReviewInput = z.infer<typeof qcReviewSchema>;
