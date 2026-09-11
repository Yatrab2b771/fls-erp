import { z } from "zod";

// --- QC Sample Store — the pre-production sample lifecycle scoped to one
// batch (see schema.prisma's QcSampleTransfer/QcSampleTransaction comment
// block). The TO_QC send itself isn't a separate action here — it's
// created as part of logging Dispensing's SAMPLE-purpose consumption
// (see transition.ts) — so this module only covers what happens once
// that sample has left the Plant: QC confirming receipt, testing it, and
// returning any leftover. ---

export const consumeQcSampleSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  consumeReason: z.enum(["TESTING", "WASTAGE", "REJECTED"]),
  note: z.string().max(500).optional(),
});

export const returnQcSampleSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40),
  note: z.string().max(500).optional(),
});

export type ConsumeQcSampleInput = z.infer<typeof consumeQcSampleSchema>;
export type ReturnQcSampleInput = z.infer<typeof returnQcSampleSchema>;
