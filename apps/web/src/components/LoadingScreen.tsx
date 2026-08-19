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
        {/* Logo badge with a ring that orbits around it — a spinner framing
            the mark itself rather than a separate loading indicator. */}
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-brand-100 border-t-brand-600 motion-reduce:animate-none" style={{ animationDuration: "1.1s" }} />
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_18px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
            <Microscope className="h-5.5 w-5.5 text-white" strokeWidth={2} />
          </div>
        </div>
        <div className="text-center">
          <p className="text-sm font-black tracking-tight text-slate-900">FLS ERP</p>
          <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
        </div>
      </div>
    </div>
  );
}
