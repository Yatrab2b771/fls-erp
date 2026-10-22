import { z } from "zod";

export const createTransporterSchema = z.object({
  name: z.string().trim().min(1, "Enter the transporter's name").max(200),
  // The Transporter ID the e-way bill asks for (15 characters, GST-style). Optional: Dispatch may not have it at hand.
  transporterId: z
    .string()
    .trim()
    .toUpperCase()
    .max(40)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const updateTransporterSchema = createTransporterSchema.partial();

export type CreateTransporterInput = z.infer<typeof createTransporterSchema>;
export type UpdateTransporterInput = z.infer<typeof updateTransporterSchema>;
