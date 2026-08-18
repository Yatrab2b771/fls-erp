export function SkeletonRows({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card overflow-hidden">
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 p-4">
            {Array.from({ length: cols }).map((_, c) => (
              <div key={c} className="skeleton h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="card space-y-3 p-5">
      <div className="skeleton h-5 w-1/3" />
      <div className="skeleton h-3.5 w-2/3" />
      <div className="skeleton h-3.5 w-1/2" />
    </div>
  );
}
