import type { LucideIcon } from "lucide-react";

const ACCENT_CLASSES: Record<string, { bg: string; text: string; bar: string }> = {
  brand: { bg: "bg-brand-500/10", text: "text-brand-600", bar: "from-brand-400 to-brand-600" },
  emerald: { bg: "bg-emerald-500/10", text: "text-emerald-600", bar: "from-emerald-400 to-emerald-600" },
  amber: { bg: "bg-amber-500/10", text: "text-amber-600", bar: "from-amber-400 to-amber-600" },
  rose: { bg: "bg-rose-500/10", text: "text-rose-600", bar: "from-rose-400 to-rose-600" },
  violet: { bg: "bg-violet-500/10", text: "text-violet-600", bar: "from-violet-400 to-violet-600" },
  blue: { bg: "bg-blue-500/10", text: "text-blue-600", bar: "from-blue-400 to-blue-600" },
  slate: { bg: "bg-slate-500/10", text: "text-slate-500", bar: "from-slate-300 to-slate-400" },
};

export function StatTile({ icon: Icon, label, value, accent = "brand" }: { icon: LucideIcon; label: string; value: string | number; accent?: keyof typeof ACCENT_CLASSES }) {
  const classes = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.brand!;
  return (
    <div className="stat-tile relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${classes.bar}`} />
      <div className={`stat-icon ${classes.bg} ${classes.text}`}>
        <Icon className="h-5 w-5" strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-black leading-none tracking-tight text-slate-900">{value}</p>
        <p className="mt-1 truncate text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      </div>
    </div>
  );
}
