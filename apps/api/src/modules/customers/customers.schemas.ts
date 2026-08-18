import { z } from "zod";

export const createCustomerSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactPerson: z.string().max(200).optional(),
  contactNo: z.string().max(40).optional(),
  gstNo: z.string().max(40).optional(),
  email: z.string().email().max(200).optional(),
  deliveryAddress: z.string().max(500).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
