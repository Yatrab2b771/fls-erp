import { z } from "zod";

/** The login ID: short, lower case, no spaces. The admin who creates the account types it. */
export const loginIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,39}$/, "Login ID: 3 to 40 characters, letters, numbers, dot, dash or underscore, no spaces.");

export const passwordSchema = z.string().min(10, "Password must be at least 10 characters");

// A login is by the login ID or by the email: the screen sends one value as `login` (older callers send it as `email`).
export const loginSchema = z
  .object({
    login: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).optional(),
    password: z.string().min(1),
  })
  .refine((d) => !!(d.login || d.email), { message: "Enter your login ID or email" });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
