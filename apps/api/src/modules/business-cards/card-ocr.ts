import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { env } from "../../common/lib/env";
import { FIELDS, parseCard, scoreParsed, type Field, type OcrLine, type ParsedCard } from "./card-parser";

// Reads a visiting card photo, free and on our own server (Tesseract). Accuracy comes from three things:
//   1. the photo is cleaned first (straightened, sharpened, contrast raised, made big enough, dark cards flipped to dark-on-light),
//   2. it is read more than once in different ways and the reading that gives the best-looking card is kept,
//   3. the text is sorted into fields by card-parser.ts, which knows what a name / company / phone / GST looks like.

type Lang = "eng" | "eng+hin";

// tesseract.js wants every language file in ONE folder; the two npm data packages are separate, so copy them side by side once.
let langDirPromise: Promise<string> | null = null;
function langDir(): Promise<string> {
  langDirPromise ??= (async () => {
    const dir = path.join(path.resolve(env.UPLOADS_DIR), ".ocr-lang");
    fs.mkdirSync(dir, { recursive: true });
    for (const code of ["eng", "hin"] as const) {
      const target = path.join(dir, `${code}.traineddata.gz`);
      if (fs.existsSync(target)) continue;
      const pkg = require(`@tesseract.js-data/${code}`) as { langPath: string };
      fs.copyFileSync(path.join(`${pkg.langPath}_best_int`, `${code}.traineddata.gz`), target);
    }
    return dir;
  })();
  return langDirPromise;
}

const workers = new Map<Lang, Promise<Worker>>();
function getWorker(lang: Lang): Promise<Worker> {
  let w = workers.get(lang);
  if (!w) {
    w = langDir().then((langPath) => createWorker(lang.split("+"), 1, { langPath, gzip: true, cachePath: langPath }));
    workers.set(lang, w);
  }
  return w;
}

/** Reading is one-at-a-time per worker; a queue keeps two scans from stepping on each other. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

export class CardPhotoError extends Error {}

/** Is the photo one that can be read at all (opens, big enough)? Checked before a scan is accepted, so the person is told at once. */
export async function checkCardPhoto(input: Buffer): Promise<void> {
  const meta = await sharp(input, { failOn: "none" }).rotate().metadata();
  if (!meta.width || !meta.height) throw new CardPhotoError("That photo could not be opened.");
  if (Math.min(meta.width, meta.height) < 300) throw new CardPhotoError("The photo is too small to read. Please take it closer, in good light.");
}

/** The photo, made easier to read. `variant` picks how hard to push the contrast. */
async function prepare(input: Buffer, variant: "soft" | "hard"): Promise<{ png: Buffer; dark: boolean }> {
  const base = sharp(input, { failOn: "none" }).rotate(); // honours the phone's rotation
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new CardPhotoError("That photo could not be opened.");
  if (Math.min(meta.width, meta.height) < 300) throw new CardPhotoError("The photo is too small to read. Please take it closer, in good light.");

  const longSide = Math.max(meta.width, meta.height);
  const target = longSide < 1600 ? 2200 : longSide > 2800 ? 2800 : longSide; // small photos are enlarged, huge ones shrunk
  const resized = base.clone().resize({ width: meta.width >= meta.height ? target : undefined, height: meta.height > meta.width ? target : undefined, kernel: "lanczos3", withoutEnlargement: false }).grayscale();

  const stats = await resized.clone().stats();
  const mean = stats.channels[0]!.mean;
  const dark = mean < 110; // light text on a dark card: flip it, Tesseract reads dark-on-light best

  let img = resized.clone().normalise();
  if (dark) img = img.negate();
  img = variant === "soft" ? img.sharpen({ sigma: 1.1 }) : img.median(3).sharpen({ sigma: 1.6 }).linear(1.25, -25).threshold(150);
  return { png: await img.png().toBuffer(), dark };
}

type TesseractLine = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };

type Layout = "block" | "sparse" | "auto";
async function recognise(png: Buffer, lang: Lang, layout: Layout): Promise<OcrLine[]> {
  return exclusive(async () => {
    const worker = await getWorker(lang);
    // "block" reads a tidy card best; "sparse" finds big logo lettering and text scattered over a busy design; "auto" lets Tesseract decide.
    await worker.setParameters({ tessedit_pageseg_mode: layout === "sparse" ? PSM.SPARSE_TEXT : layout === "auto" ? PSM.AUTO : PSM.SINGLE_BLOCK });
    const { data } = await worker.recognize(png, {}, { blocks: true });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const l of para.lines as unknown as TesseractLine[]) {
          const text = l.text.replace(/\s+/g, " ").trim();
          if (!text) continue;
          lines.push({ text, conf: Math.max(0, Math.min(1, l.confidence / 100)), height: l.bbox.y1 - l.bbox.y0, top: l.bbox.y0, left: l.bbox.x0, right: l.bbox.x1 });
        }
      }
    }
    return lines.sort((a, b) => a.top - b.top);
  });
}

/** How much real text a reading found: confident characters. Used to compare angles. */
const textScore = (lines: OcrLine[]) => lines.filter((l) => l.conf >= 0.5).reduce((a, l) => a + l.text.replace(/[^A-Za-z0-9]/g, "").length * l.conf, 0);

/**
 * Phone photos are rarely straight, and the card is often a small part of the picture. Before reading, find the angle at which the text reads
 * best (a quick low-detail reading at a few angles), straighten the photo, and cut it down to the area that holds text, so the real reading
 * sees the card big and level. If nothing readable is found, the photo is returned as it is.
 */
async function straightenAndCrop(photo: Buffer): Promise<Buffer> {
  const oriented = await sharp(photo, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  if (!meta.width || !meta.height) return photo;
  const bg = await sharp(oriented).resize(1, 1).raw().toBuffer(); // the photo's average colour fills the corners a rotation opens up
  const background = { r: bg[0] ?? 255, g: bg[1] ?? 255, b: bg[2] ?? 255 };

  const probeWidth = meta.width >= meta.height ? 1400 : Math.round((1400 * meta.width) / meta.height);
  const probe = await sharp(oriented).resize({ width: probeWidth, kernel: "lanczos3" }).grayscale().normalise().sharpen({ sigma: 1 }).png().toBuffer();

  const at = async (angle: number) => {
    const img = angle === 0 ? probe : await sharp(probe).rotate(angle, { background }).png().toBuffer();
    const lines = await recognise(img, "eng", "sparse");
    return { angle, lines, score: textScore(lines), img };
  };

  let best = await at(0);
  const goodAlready = best.lines.length >= 5 && best.lines.filter((l) => l.conf >= 0.7).length >= 0.7 * best.lines.length;
  if (!goodAlready) {
    for (const angle of [10, -10, 20, -20]) {
      const t = await at(angle);
      if (t.score > best.score) best = t;
    }
    // tilt is usually between the steps tried: look a little either side of the best one
    if (best.angle !== 0) {
      for (const angle of [best.angle - 5, best.angle + 5]) {
        const t = await at(angle);
        if (t.score > best.score) best = t;
      }
    }
  }
  if (best.score < 8) return photo; // nothing readable: leave the photo alone

  // The picture, turned the same way at full size
  const full = best.angle === 0 ? oriented : await sharp(oriented).rotate(best.angle, { background }).toBuffer();
  const fullMeta = await sharp(full).metadata();
  const probeMeta = await sharp(best.img).metadata();
  const scale = (fullMeta.width ?? 1) / (probeMeta.width ?? 1);

  // Crop to where the text is (with a margin), when that is clearly smaller than the whole picture
  const solid = best.lines.filter((l) => l.conf >= 0.5 && l.left !== undefined && l.right !== undefined);
  if (solid.length >= 3) {
    const x0 = Math.min(...solid.map((l) => l.left!));
    const x1 = Math.max(...solid.map((l) => l.right!));
    const y0 = Math.min(...solid.map((l) => l.top));
    const y1 = Math.max(...solid.map((l) => l.top + l.height));
    const pw = probeMeta.width ?? 1;
    const ph = probeMeta.height ?? 1;
    const mx = (x1 - x0) * 0.12;
    const my = (y1 - y0) * 0.12;
    const left = Math.max(0, Math.floor((x0 - mx) * scale));
    const top = Math.max(0, Math.floor((y0 - my) * scale));
    const width = Math.min((fullMeta.width ?? 1) - left, Math.ceil((x1 - x0 + 2 * mx) * scale));
    const height = Math.min((fullMeta.height ?? 1) - top, Math.ceil((y1 - y0 + 2 * my) * scale));
    if (width * height < 0.8 * pw * ph * scale * scale && width > 200 && height > 120) {
      return sharp(full).extract({ left, top, width, height }).png().toBuffer();
    }
  }
  return best.angle === 0 ? photo : sharp(full).png().toBuffer();
}

export type CardReading = ParsedCard & { lines: OcrLine[]; passes: number };

/** Reads a card photo. `known` are company names we already know (customers, vendors, earlier cards) to help spell the company right. */
export async function readCard(original: Buffer, known: string[]): Promise<CardReading> {
  const photo = await straightenAndCrop(original).catch(() => original);
  const attempts: { lines: OcrLine[]; parsed: ParsedCard; score: number }[] = [];
  const attempt = async (variant: "soft" | "hard", lang: Lang, layout: Layout) => {
    const { png } = await prepare(photo, variant);
    const lines = await recognise(png, lang, layout);
    const parsed = parseCard(lines, known);
    attempts.push({ lines, parsed, score: scoreParsed(parsed, lines) });
  };

  const bestSoFar = () => Math.max(...attempts.map((a) => a.score));
  await attempt("soft", "eng", "block");
  // A clearly good first reading is enough. Otherwise read again in other ways (sparse layout, harder contrast) and keep whichever looks best.
  if (bestSoFar() < 0.9) await attempt("soft", "eng", "sparse");
  if (bestSoFar() < 0.85) await attempt("hard", "eng", "auto");
  if (bestSoFar() < 0.7) await attempt("hard", "eng", "sparse");

  // Start from the best-looking reading, then take any single field that another reading was more sure of (one pass may catch the big logo
  // name, another the full address with its pincode).
  const best = attempts.reduce((a, b) => (b.score > a.score ? b : a));
  const merged: ParsedCard = { ...best.parsed, phones: [...best.parsed.phones], confidence: { ...best.parsed.confidence } };
  for (const field of FIELDS) {
    for (const other of attempts) {
      if (other === best) continue;
      if (field === "phone") continue;
      const key = field === "gstNo" ? "gstNo" : field;
      const value = other.parsed[key as Exclude<Field, "phone">];
      if (value && other.parsed.confidence[field] > merged.confidence[field] + 0.03) {
        merged[key as Exclude<Field, "phone">] = value;
        merged.confidence[field] = other.parsed.confidence[field];
      }
    }
  }
  for (const other of attempts) {
    for (const ph of other.parsed.phones) {
      if (!merged.phones.some((x) => x.replace(/\D/g, "").slice(-10) === ph.replace(/\D/g, "").slice(-10))) merged.phones.push(ph);
    }
  }
  if (merged.phones.length) merged.confidence.phone = Math.max(...attempts.map((a) => a.parsed.confidence.phone));

  const seen = new Set<string>();
  const lines = [...best.lines, ...attempts.filter((a) => a !== best).flatMap((a) => a.lines)].filter((l) => {
    const k = l.text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...merged, lines, passes: attempts.length };
}

export async function stopOcr(): Promise<void> {
  const all = await Promise.all([...workers.values()]);
  workers.clear();
  await Promise.all(all.map((w) => w.terminate()));
}
