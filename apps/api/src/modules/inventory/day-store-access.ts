import { prisma } from "../../common/lib/prisma";
import { RouteError } from "../../common/lib/route-error";
import type { RoleName } from "@prisma/client";
import type { NextFunction, Response } from "express-serve-static-core";
import type { AuthedRequest } from "../../common/middleware/auth";
import { adminViewScope } from "../../common/lib/view-scope";

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
  const viewing = adminViewScope(roles)?.dayStoreIds;
  if (viewing) {
    if (!viewing.includes(dayStoreId)) throw new RouteError(403, "You are not assigned to this store.");
    return;
  }
  if (roles.includes("ADMIN") || roles.includes("PPIC")) return;

  const assignments = await prisma.dayStoreAssignment.findMany({ where: { userId }, select: { dayStoreId: true } });
  if (assignments.length === 0) return; // unrestricted default

  if (!assignments.some((a) => a.dayStoreId === dayStoreId)) {
    throw new RouteError(403, "You are not assigned to this store.");
  }
}

/**
 * The Day Stores this user is limited to, or null when they are not limited to any (ADMIN, PPIC, or a
 * STORE user with no assignment - the Warehouse-side Store seat). A limited user works like a Warehouse
 * for their own store(s) only, and does not see the Warehouse-side lists.
 */
export async function getScopedDayStoreIds(userId: string, roles: RoleName[]): Promise<string[] | null> {
  // An admin viewing as one Day Store is scoped to it, exactly like that store's own login.
  const viewing = adminViewScope(roles)?.dayStoreIds;
  if (viewing) return viewing;
  if (roles.includes("ADMIN") || roles.includes("PPIC")) return null;
  const assignments = await prisma.dayStoreAssignment.findMany({ where: { userId }, select: { dayStoreId: true } });
  return assignments.length === 0 ? null : assignments.map((a) => a.dayStoreId);
}

/** Keeps a Day-Store-limited user off the Warehouse-side lists (a Day Store sees only its own store). */
export async function requireWarehouseSeat(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if ((await getScopedDayStoreIds(req.user!.id, req.user!.roles)) !== null) {
      return res.status(403).json({ error: "This list is for the Warehouse. A Day Store login sees its own store only." });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The Plants this PRODUCTION user is limited to, or null when they are not limited (ADMIN, PPIC, a Production user with no
 * assignment - the original all-Plants seat - or anyone who is not Production). A limited Production user sees and acts on
 * those Plants' runs, batches, consumption and transfers only.
 */
export async function getScopedPlantIds(userId: string, roles: RoleName[]): Promise<string[] | null> {
  // An admin viewing as one Plant is scoped to it, exactly like that Plant's own Production login.
  const viewing = adminViewScope(roles)?.plantIds;
  if (viewing) return viewing;
  if (roles.includes("ADMIN") || roles.includes("PPIC") || !roles.includes("PRODUCTION")) return null;
  const rows = await prisma.plantAssignment.findMany({ where: { userId }, select: { plantId: true } });
  return rows.length === 0 ? null : rows.map((r) => r.plantId);
}

/** Throws a 403 when a Plant-limited Production user touches something that belongs to another Plant (or to no Plant). */
export async function assertPlantAccess(userId: string, roles: RoleName[], plantId: string | null | undefined): Promise<void> {
  const scope = await getScopedPlantIds(userId, roles);
  if (scope === null) return;
  if (!plantId || !scope.includes(plantId)) throw new RouteError(403, "This belongs to another Plant - your login covers only your own Plant.");
}

/**
 * Material Received & GRN and Dispensing / RM-PM Issue are done by the Day Store of the run's own Plant (the material reaches the
 * Plant through it), not by the Warehouse and not by another store. ADMIN may step in; a run with no Plant yet has no Day Store
 * to do it, so only ADMIN can move it.
 */
export async function assertRunDayStoreAccess(userId: string, roles: RoleName[], plantId: string | null | undefined): Promise<void> {
  const viewing = adminViewScope(roles)?.dayStoreIds;
  if (!viewing && (roles.includes("ADMIN") || !roles.includes("STORE"))) return;
  const scope = await getScopedDayStoreIds(userId, roles);
  if (scope === null) throw new RouteError(403, "This step is done by the Day Store of the run's Plant, not by the Warehouse.");
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId }, select: { dayStoreId: true } }) : null;
  if (!plant?.dayStoreId || !scope.includes(plant.dayStoreId)) throw new RouteError(403, "This run belongs to another Plant - this step is done by that Plant's Day Store.");
}
