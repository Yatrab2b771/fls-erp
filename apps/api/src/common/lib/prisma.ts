import { PrismaClient } from "@prisma/client";

// Reuse the same client across tsx watch hot-reloads in dev, same as the
// pre-rebuild version — without this, every file save opens a fresh pool
// of Postgres connections until the DB refuses new ones.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
