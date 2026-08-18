import rateLimit from "express-rate-limit";

// Capped generously for a real user who mistypes a password, punishing for
// a credential-stuffing script. Keyed by IP (the default), not email, so
// it can't be used to lock another user out of their own account.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again later." },
});
