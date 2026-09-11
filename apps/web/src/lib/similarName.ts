// Guards the exact scenario that prompted this: BD types "BCA" on a PO,
// the catalog actually has "BAC" (a spelling mistake from an earlier
// Import Catalog), the two never exact-match, and "+ New" quietly
// creates a second, near-duplicate Brand instead of finding the real
// one. This doesn't block creation — a genuinely new, similarly-named
// brand is real — it just asks first instead of silently duplicating.

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

/** Closest existing name within a small edit distance — null if the typed name is an exact match already, or nothing is close. */
export function findSimilarName(name: string, existing: string[]): string | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  // Scales with length — "BCA"/"BAC" (distance 2, len 3) needs a looser
  // bound than a long name, where distance 2 is nearly always a real typo.
  const threshold = target.length <= 4 ? 2 : target.length <= 8 ? 2 : 3;
  let best: { name: string; dist: number } | null = null;
  for (const candidate of existing) {
    const c = candidate.trim().toLowerCase();
    if (c === target) return null; // exact match — not a "did you mean", just the same thing
    const dist = levenshtein(target, c);
    if (dist <= threshold && (!best || dist < best.dist)) best = { name: candidate, dist };
  }
  return best?.name ?? null;
}
