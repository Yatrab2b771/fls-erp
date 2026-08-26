import { prisma } from "../../common/lib/prisma";
import { RouteError } from "../../common/lib/route-error";
import type { RoleName } from "@prisma/client";

// Enforces DayStoreAssignment (see schema.prisma) — a STORE-department
// user restricted to specific store(s) can't act on or view any other
// store. Two built-in exemptions, always unrestricted regardless of
// assignment rows: ADMIN (same data-correction bypass reasoning as
// everywhere else in this module), and PPIC (explicitly kept
// unrestricted — it's a read-only, company-wide planning role, not a
// Store-department seat this feature is scoping down).
//
// No assignment rows for a user at all = unrestricted — this is what
// keeps every existing/seeded STORE user working exactly as before this
// feature shipped. A user only becomes scoped to specific stores once
// someone explicitly assigns them to at least one.
export async function assertDayStoreAccess(userId: string, roles: RoleName[], dayStoreId: string): Promise<void> {
  if (roles.includes("ADMIN") || roles.includes("PPIC")) return;

  const assignments = await prisma.dayStoreAssignment.findMany({ where: { userId }, select: { dayStoreId: true } });
  if (assignments.length === 0) return; // unrestricted default

  if (!assignments.some((a) => a.dayStoreId === dayStoreId)) {
    throw new RouteError(403, "You are not assigned to this store.");
  }
}
