import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env";

// Local-disk storage for v1 — no cloud dependency, matching this project's
// dev-only posture. Every caller goes through this module, not raw `fs`,
// so swapping to S3-compatible storage later touches one file, not every
// route that uploads something.
const uploadsRoot = path.resolve(env.UPLOADS_DIR);
fs.mkdirSync(uploadsRoot, { recursive: true });

/** Writes a buffer under a random filename (extension preserved) and returns the storage path to persist in the DB. */
export function saveUploadedFile(originalName: string, buffer: Buffer): string {
  const ext = path.extname(originalName);
  const storedName = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(uploadsRoot, storedName), buffer);
  return storedName;
}

export function resolveStoragePath(storagePath: string): string {
  return path.join(uploadsRoot, storagePath);
}

export function deleteUploadedFile(storagePath: string): void {
  const full = resolveStoragePath(storagePath);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}
