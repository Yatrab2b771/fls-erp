import { prisma } from "./prisma";

/** Records one append-only audit fact. Called explicitly at the point of a mutating action, not via generic request logging. */
export async function recordAudit(entry: {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata as never,
    },
  });
}
