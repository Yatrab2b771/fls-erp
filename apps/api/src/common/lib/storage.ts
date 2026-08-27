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

// Magic-byte signatures for the file types a PO document upload is allowed
// to be. Checked against the real bytes of the upload — never the client's
// claimed filename or Content-Type, both of which are just text the
// uploader typed or set on the request and are trivially spoofed (e.g. an
// .exe renamed to "invoice.pdf" and sent with Content-Type:
// application/pdf sails straight past a filename/mimetype-only check).
// This is the one place in the app that accepts an arbitrary file from a
// user, so it's the one place a mislabeled executable or other malware
// could ride in disguised as a scan/PDF; matching real signatures closes
// that off regardless of what the request claims about itself.
const FILE_SIGNATURES: ReadonlyArray<{ ext: string; mimeType: string; matches: (buf: Buffer) => boolean }> = [
  { ext: ".pdf", mimeType: "application/pdf", matches: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { ext: ".jpg", mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".png", mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".gif", mimeType: "image/gif", matches: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: ".webp", mimeType: "image/webp", matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: ".bmp", mimeType: "image/bmp", matches: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

/**
 * Identifies a file by its actual bytes, ignoring whatever the client
 * claimed about it. Returns null if it isn't one of the types a PO
 * document is allowed to be — the caller should reject the upload outright
 * rather than store it.
 */
export function detectFileType(buffer: Buffer): { ext: string; mimeType: string } | null {
  const sig = FILE_SIGNATURES.find((s) => {
    try {
      return s.matches(buffer);
    } catch {
      return false;
    }
  });
  return sig ? { ext: sig.ext, mimeType: sig.mimeType } : null;
}

/**
 * Writes a buffer to disk under a random filename with the given
 * extension and returns the storage path to persist in the DB. The
 * extension must come from `detectFileType`, not from the client-supplied
 * original filename — see the signature check above.
 */
export function saveUploadedFile(ext: string, buffer: Buffer): string {
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
