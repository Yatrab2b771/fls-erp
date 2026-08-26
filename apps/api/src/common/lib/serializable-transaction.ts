import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// Wraps prisma.$transaction under SERIALIZABLE isolation, retrying a
// handful of times on Postgres's serialization-failure error (SQLSTATE
// 40001, surfaced by Prisma as P2034). That failure is Postgres's normal
// way of telling two concurrent transactions "one of you has to redo
// this" when their reads/writes would otherwise interleave into a bad
// result — not a real error, just a signal to retry the whole callback
// from scratch. Used anywhere a check-then-write (e.g. "is there enough
// stock on hand?" then "create the issuing transaction") has to be
// atomic across concurrent requests — see inventory.routes.ts's issue
// endpoints, where two Store users acting on the same item at once
// could otherwise both pass the same stock check before either write
// lands, double-issuing past what's actually on the shelf.
export async function runSerializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      const isSerializationFailure = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (!isSerializationFailure || attempt === attempts) throw err;
      // No backoff needed — a serialization failure means the other
      // transaction already committed, so an immediate retry reads
      // fresh, consistent data rather than the stale snapshot that
      // caused the conflict.
    }
  }
  // Unreachable — the loop above always returns or throws — but keeps
  // the function's return type from being `T | undefined`.
  throw new Error("runSerializable: exhausted retries without returning or throwing");
}
