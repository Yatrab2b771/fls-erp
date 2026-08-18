import type { LucideIcon } from "lucide-react";

// Tailwind's JIT scanner can't see dynamically-built class names
// (`bg-${accent}-50`), so the accent options are spelled out in full here
// rather than interpolated — anything not literally present as a class
// string gets purged from the production build.
const ACCENT_CLASSES: Record<string, { bg: string; text: string }> = {
  brand: { bg: "bg-brand-50", text: "text-brand-300" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-300" },
  amber: { bg: "bg-amber-50", text: "text-amber-300" },
  rose: { bg: "bg-rose-50", text: "text-rose-300" },
  violet: { bg: "bg-violet-50", text: "text-violet-300" },
  slate: { bg: "bg-slate-100", text: "text-slate-300" },
};

export function EmptyState({ icon: Icon, title, hint, accent = "brand" }: { icon: LucideIcon; title: string; hint?: string; accent?: keyof typeof ACCENT_CLASSES }) {
  const classes = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.brand!;
  return (
    <div className="card flex flex-col items-center justify-center gap-3 p-14 text-center">
      <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${classes.bg}`}>
        <Icon className={`h-7 w-7 ${classes.text}`} strokeWidth={1.75} />
      </div>
      <p className="text-sm font-bold text-slate-600">{title}</p>
      {hint && <p className="max-w-xs text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
