import { z } from "zod";
import { RouteError } from "../../common/lib/route-error";

/**
 * Receiving a movement between two places (a stock transfer, an R&D transfer, a transit-tracked issue). The sender's balance has
 * already dropped by the full quantity; whoever receives it now says how much actually arrived. Less than was sent is allowed -
 * but only with a reason, and the difference is kept as a recorded transit loss (shortQty) instead of silently disappearing.
 */
export const receiveTransferSchema = z.object({
  note: z.string().trim().max(500).optional(),
  /** What actually arrived. Leave out when everything arrived. */
  receivedQty: z.coerce.number().positive().optional(),
});
export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>;

/** The receiver refuses the movement: the material goes back to the sender's stock. */
export const rejectTransferSchema = z.object({
  reason: z.string().trim().min(1, "Say why it is being refused.").max(500),
});
export type RejectTransferInput = z.infer<typeof rejectTransferSchema>;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function resolveShortReceipt(sent: number, input: ReceiveTransferInput): { receivedQty: number; shortQty: number | null; shortNote: string | null } {
  const received = input.receivedQty ?? sent;
  if (received > sent + 1e-9) throw new RouteError(400, `Only ${sent} was sent - you can't receive more than that.`);
  const short = round3(sent - received);
  if (short <= 1e-9) return { receivedQty: sent, shortQty: null, shortNote: null };
  if (!input.note) throw new RouteError(400, `Only ${received} of ${sent} arrived - write what happened to the other ${short}.`);
  return { receivedQty: round3(received), shortQty: short, shortNote: input.note };
}
