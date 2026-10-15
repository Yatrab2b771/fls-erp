import type { Prisma } from "@prisma/client";

// Every save of a Packaging BOM (kind "PM", entityId = Sku id) or an RM recipe (kind "RM", entityId =
// Recipe id) is kept as a numbered snapshot. The live tables always hold the latest version; restoring an
// old one writes it back as a NEW version, so nothing is ever lost.

export type BomKind = "PM" | "RM";

export type Tx = Prisma.TransactionClient;

async function nextVersion(tx: Tx, kind: BomKind, entityId: string): Promise<number> {
  const last = await tx.bomVersion.findFirst({ where: { kind, entityId }, orderBy: { version: "desc" }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

export async function writeVersion(tx: Tx, kind: BomKind, entityId: string, snapshot: unknown, note: string | null | undefined, userId: string | null): Promise<number> {
  const version = await nextVersion(tx, kind, entityId);
  await tx.bomVersion.create({ data: { kind, entityId, version, note: note?.trim() || null, snapshot: snapshot as Prisma.InputJsonValue, createdById: userId } });
  return version;
}
