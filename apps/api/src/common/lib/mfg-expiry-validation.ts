import { z } from "zod";

// Shared by every schema that accepts mfgDate/expiryDate on a Material
// Received-shaped row (the manual Log Entry form, editing an existing
// entry, the bulk import, and Vendor PO "Mark Received") — one rule,
// checked the same way everywhere instead of copy-pasted per schema:
//   - Mfg Date can't be later than today (nothing's been manufactured
//     that hasn't happened yet).
//   - Expiry Date can't already be in the past at entry time — that's
//     different from the Quarantine Store's own auto-expiry (see
//     stock.ts), which is for stock that *becomes* expired later, not
//     stock entered as already-expired from day one.
//   - Expiry Date can't be before Mfg Date.
// Comparisons use start/end-of-day so today's own date is always valid
// on both fields regardless of what time of day the request lands.
export function validateMfgExpiryDates(data: { mfgDate?: Date; expiryDate?: Date }, ctx: z.RefinementCtx): void {
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  if (data.mfgDate && data.mfgDate > endOfToday) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Mfg Date can't be in the future", path: ["mfgDate"] });
  }
  if (data.expiryDate && data.expiryDate < startOfToday) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expiry Date can't already be in the past", path: ["expiryDate"] });
  }
  if (data.mfgDate && data.expiryDate && data.expiryDate < data.mfgDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expiry Date can't be before Mfg Date", path: ["expiryDate"] });
  }
}
