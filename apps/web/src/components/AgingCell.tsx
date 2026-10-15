const DAY_MS = 86_400_000;

/** Whole days since `since`, never negative; null when there is no date. */
export function agingDays(since: string | null | undefined): number | null {
  if (!since) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / DAY_MS));
}

// The Aging filter's buckets (same labels the server understands), as whole-day ranges.
const BUCKETS: Record<string, [number, number]> = {
  "0-7 days": [0, 7],
  "8-15 days": [8, 15],
  "16-30 days": [16, 30],
  "31-60 days": [31, 60],
  "60+ days": [61, Infinity],
};

/** Is a row aged `days` inside any of the picked buckets (true when none is picked)? */
export function inAgingBuckets(days: number | null, picked: string[]): boolean {
  if (picked.length === 0) return true;
  if (days === null) return false;
  return picked.some((label) => {
    const range = BUCKETS[label];
    return !!range && days >= range[0] && days <= range[1];
  });
}

/**
 * How long a row has been in the list it is shown in (since it entered this
 * state - not since the order date). Amber from 30 days, red from 60.
 */
export function AgingCell({ since }: { since: string | null | undefined }) {
  const days = agingDays(since);
  if (days === null) return <span className="text-slate-300">—</span>;
  const tone = days >= 60 ? "border-rose-200 bg-rose-50 text-rose-700" : days >= 30 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <span className={`pill whitespace-nowrap tabular-nums ${tone}`} title={`In this list since ${new Date(since!).toLocaleDateString()}`}>
      {days === 0 ? "Today" : `${days}d`}
    </span>
  );
}
