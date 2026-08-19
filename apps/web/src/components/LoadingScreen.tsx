import { Microscope } from "lucide-react";

// The branded full-screen loading state — shown while the initial
// "who am I" auth check is in flight (see App.tsx). Mirrors the navbar's
// logo treatment (AppLayout.tsx) so the app doesn't flash an unbranded
// "Loading…" text before its own chrome ever appears.
export function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.08)" }} />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.07)" }} />
      </div>

      <div className="relative flex flex-col items-center gap-4">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_18px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
          <div className="absolute inset-0 -z-10 animate-pulse rounded-2xl bg-brand-500 opacity-40 blur-xl motion-reduce:animate-none" />
          <Microscope className="h-7 w-7 text-white" strokeWidth={2} />
        </div>
        <div className="text-center">
          <p className="text-sm font-black tracking-tight text-slate-900">FLS ERP</p>
          <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
        </div>
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 motion-reduce:animate-none"
              style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
