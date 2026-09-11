import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import type { Prisma } from "@prisma/client";

// --- Admin-only operational tooling — a live snapshot of "is this
// actually working" (System Health) and a read view onto the AuditLog
// table every mutating action in this app already writes to via
// recordAudit() (Audit Log). Neither exposes any data that doesn't
// already exist; this only makes it visible from the UI instead of a
// direct DB query. Gated the same way Users/Recycle Bin already are —
// requireRole("ADMIN"), nothing narrower. ---

export const systemRouter = Router();

systemRouter.use(requireAuth);

systemRouter.get("/health", requireRole("ADMIN"), async (_req, res) => {
  try {
    const dbStart = Date.now();
    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    const database = rows[0]?.current_database ?? "unknown";
    const dbLatencyMs = Date.now() - dbStart;

    const [userCount, activeUserCount, batchCount, purchaseOrderCount, auditLogCount] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.preProduction.count(),
      prisma.purchaseOrder.count(),
      prisma.auditLog.count(),
    ]);

    const mem = process.memoryUsage();

    res.json({
      status: "ok",
      db: { connected: true, database, latencyMs: dbLatencyMs },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        env: process.env.NODE_ENV ?? "development",
        memoryMb: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024), heapTotal: Math.round(mem.heapTotal / 1024 / 1024) },
      },
      counts: { users: userCount, activeUsers: activeUserCount, batches: batchCount, purchaseOrders: purchaseOrderCount, auditLogEntries: auditLogCount },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    // A DB failure here is the one interesting case this panel exists
    // to surface — report it as a 200 "unhealthy" body, not a 500,
    // so the page can render a clear "DB unreachable" card instead of
    // just erroring out like every other endpoint's failure would.
    res.json({ status: "error", db: { connected: false }, error: err instanceof Error ? err.message : "Unknown error", checkedAt: new Date().toISOString() });
  }
});

systemRouter.get("/audit-log", requireRole("ADMIN"), async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const { action, entityType, actorId } = req.query as { action?: string; entityType?: string; actorId?: string };

    const where: Prisma.AuditLogWhereInput = {
      ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
      ...(entityType ? { entityType: { contains: entityType, mode: "insensitive" } } : {}),
      ...(actorId ? { actorId } : {}),
    };

    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, employeeId: true, fullName: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});
