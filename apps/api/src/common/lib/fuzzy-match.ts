// Typo-tolerant name matching — used wherever a PO's free-text product
// name is matched against a maintained catalog (Packaging BOM's Sku,
// RM Costing's Recipe) by exact name today. An exact match either finds
// the real thing or finds nothing; a human typo ("Whey Protien" vs
// "Whey Protein") falls into the second case and today reads as "no
// formulation exists yet" — indistinguishable from an actually-new
// product. This gives the caller a ranked "did you mean" list instead,
// so a typo can be fixed with one click instead of a trip through R&D.
//
// Deliberately dependency-free (bigram Dice coefficient) — catalog sizes
// here are in the hundreds to low thousands, well within what a plain JS
// pass handles in a few ms, so no DB extension (pg_trgm) or npm package
// is worth the extra moving part.

function bigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

// Sørensen–Dice coefficient — 2×|intersection| / (|A|+|B|), 0..1. Robust
// to a single-character typo/transposition/insertion on names of the
// length these catalogs actually have (a few words), and unlike edit
// distance it's naturally normalized regardless of string length.
function diceCoefficient(a: string, b: string): number {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  let intersection = 0;
  for (const g of gramsA) if (gramsB.has(g)) intersection++;
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

export interface FuzzyCandidate<T> {
  item: T;
  score: number;
}

// Ranks `candidates` by name-similarity to `query`, highest first,
// keeping only scores >= minScore (default 0.5 — loose enough to catch
// a one-letter typo or a missing/extra word, tight enough not to surface
// unrelated products). Capped at `limit` (default 5) so this stays a
// short "did you mean" list, not a second catalog browser.
export function findSimilar<T>(query: string, candidates: T[], nameOf: (item: T) => string, options?: { limit?: number; minScore?: number }): FuzzyCandidate<T>[] {
  const limit = options?.limit ?? 5;
  const minScore = options?.minScore ?? 0.5;

  return candidates
    .map((item) => ({ item, score: diceCoefficient(query, nameOf(item)) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
