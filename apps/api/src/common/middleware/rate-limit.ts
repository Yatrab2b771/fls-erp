import rateLimit from "express-rate-limit";
import type { Request } from "express";

// Keyed by IP *and* email together, not IP alone. Pure-IP keying looked
// safer on paper (an attacker can't fuzz someone else's email to lock
// them out) but has the opposite real-world failure: every account
// behind the same office/NAT/reverse-proxy IP shares one 10-attempt
// bucket, so one person mistyping a password locks out the whole
// building. Combining IP+email fixes both at once — each account gets
// its own bucket per source IP, so a shared office IP no longer
// collides between accounts, and an attacker spamming a victim's email
// from a different IP only exhausts *that* IP+email pair, never the
// victim's own. req.ip is already the real client IP here, not the
// proxy's — see app.set("trust proxy", 1) in app.ts.
function loginKey(req: Request): string {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return `${req.ip ?? "unknown"}:${email}`;
}

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: loginKey,
  // Only failed logins should burn down the bucket — this is brute-force
  // protection, not a cap on how often someone can legitimately sign in.
  // Without this, switching between department accounts to test (or just
  // a flaky connection making you log in a few times) eats the same
  // 10-attempt budget as someone guessing a password, and locks out a
  // real user for no security reason.
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts — try again later." },
});
