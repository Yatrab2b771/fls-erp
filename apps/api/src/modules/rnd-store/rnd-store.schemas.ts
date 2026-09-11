import { z } from "zod";

const CONSUME_REASONS = ["TESTING", "FORMULATION_TRIAL", "WASTAGE", "REJECTED"] as const;

// Step 1 / Step 5 — Store sends a sample to R&D, or R&D sends leftover
// back to Store. `direction` picks which; the sending side's own stock
// effect (ISSUED_RND / isRndReturn) lands immediately, the other side's
// only once they confirm (see rnd-store.routes.ts).
export const createRndTransferSchema = z.object({
  direction: z.enum(["TO_RND", "TO_WAREHOUSE"]),
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  note: z.string().max(500).optional(),
});

// Step 3 — research uses/wastes/rejects part of what's on hand at R&D.
// projectName/formulationRef/batchNo let a later report answer "how much
// of item X went into formulating product Y", not just "how much of X
// was used, in general". date defaults to today at the route if omitted
// — separate from createdAt (when the row was logged, not necessarily
// when the consumption actually happened).
export const consumeAtRndSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  reason: z.enum(CONSUME_REASONS),
  date: z.coerce.date().optional(),
  projectName: z.string().max(200).optional(),
  formulationRef: z.string().max(100).optional(),
  batchNo: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
});

// Step 4 — a sample goes straight to a customer, not back through the
// Warehouse. brandName/courierDetails/date are the sample-dispatch
// paperwork the client asked for; date defaults to today at the route
// if omitted, same as consumeAtRndSchema's own.
export const dispatchToCustomerSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  customerId: z.string().uuid(),
  brandName: z.string().max(200).optional(),
  date: z.coerce.date().optional(),
  courierDetails: z.string().max(300).optional(),
  note: z.string().max(500).optional(),
});

// R&D asking Store for material — the real-world trigger for step 1 (see
// RndSampleRequest in schema.prisma). Store fulfills or rejects it.
export const createRndSampleRequestSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  note: z.string().max(500).optional(),
});

export const rejectRndSampleRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});

// Bulk request — one Excel sheet's worth of item asks at once, same
// resolve-or-create-item-by-name + createMany shape as
// /api/inventory/requests/import.
export const importRndSampleRequestsSchema = z.object({
  rows: z
    .array(
      z.object({
        category: z.enum(["RM", "PM"]),
        itemName: z.string().min(1).max(200),
        quantity: z.coerce.number().positive(),
        unit: z.string().min(1).max(40),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export type CreateRndTransferInput = z.infer<typeof createRndTransferSchema>;
export type ConsumeAtRndInput = z.infer<typeof consumeAtRndSchema>;
export type DispatchToCustomerInput = z.infer<typeof dispatchToCustomerSchema>;
export type CreateRndSampleRequestInput = z.infer<typeof createRndSampleRequestSchema>;
export type RejectRndSampleRequestInput = z.infer<typeof rejectRndSampleRequestSchema>;
export type ImportRndSampleRequestsInput = z.infer<typeof importRndSampleRequestsSchema>;
