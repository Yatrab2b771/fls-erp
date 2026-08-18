import type { NextFunction, ParamsDictionary, Request, Response } from "express-serve-static-core";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import type { RoleName } from "@prisma/client";

// Generic over route params so `req.params.foo` types as `string`, not the
// library's default `string | string[]` fallback.
export interface AuthedRequest<P extends ParamsDictionary = ParamsDictionary> extends Request<P> {
  user?: { id: string; roles: RoleName[] };
}

/**
 * Verifies the bearer token and attaches the user to the request. Also
 * checks tokenVersion/isActive against the current row so a token minted
 * before a password change/deactivation stops working immediately, not
 * just at its natural expiry.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length));
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true, tokenVersion: true } });
    if (!user || !user.isActive || user.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    req.user = { id: payload.sub, roles: payload.roles };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Gate a route to one or more roles. ADMIN always passes.
 * Usage: router.post("/x", requireAuth, requireRole("PPIC"), handler)
 */
export function requireRole(...allowed: RoleName[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const roles = req.user?.roles ?? [];
    if (roles.includes("ADMIN" as RoleName) || roles.some((r) => allowed.includes(r))) {
      return next();
    }
    return res.status(403).json({ error: "You do not have permission to perform this action" });
  };
}
