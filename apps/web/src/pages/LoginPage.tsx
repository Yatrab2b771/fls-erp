import { useState, type FormEvent } from "react";
import { ArrowRight, Beaker, Eye, EyeOff, Lock, Mail, Microscope, ShieldCheck, ShoppingCart, Sparkles, Truck, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

const PIPELINE = [
  { icon: ShoppingCart, label: "PO Release", hint: "Purchase order intake from a brand" },
  { icon: Beaker, label: "Production & QC", hint: "Dispensing, manufacturing, dual QA gates" },
  { icon: Undo2, label: "Send Back", hint: "Any department can return it for correction" },
  { icon: Truck, label: "Dispatch Plan", hint: "One flow, every department sees its status" },
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full bg-slate-50">
      {/* Hero panel — near-black graphite with a single restrained gold
          accent, not another loud indigo/violet SaaS gradient. Premium
          reads as "one confident color choice", not "four glowing blobs". */}
      <div className="relative hidden overflow-hidden bg-gradient-to-b from-[#0b0d12] via-[#101319] to-black lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12 xl:w-1/2 xl:p-16">
        {/* Fine hairline grid — barely-there texture, not decoration */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        {/* One soft light source, top-right, low-key */}
        <div className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-amber-400/[0.07] blur-3xl" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

        <div className="relative z-10 flex items-center gap-3 animate-fade-in">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/20 bg-white/[0.04] backdrop-blur">
            <Microscope className="h-5 w-5 text-amber-300" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-lg font-black leading-none tracking-tight text-white">FLS ERP</p>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300/70">Enterprise Platform</p>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-amber-400/15 bg-amber-400/[0.06] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-200/90">
            <Sparkles className="h-3 w-3" strokeWidth={2.5} /> One connected production flow
          </div>
          <h2 className="mb-4 text-3xl font-black leading-tight tracking-tight text-white xl:text-4xl">
            From purchase order
            <br />
            to dispatch —
            <span className="text-amber-300"> tracked</span>
            <br />
            end to end.
          </h2>
          <p className="mb-8 text-sm leading-relaxed text-slate-400">
            Order Tracking is one real pipeline now — Packaging BOM and RM Costing planning wired to it, not a separate, disconnected tool.
          </p>

          {/* The pipeline itself, as a live-looking vertical stepper */}
          <div className="space-y-0.5">
            {PIPELINE.map(({ icon: Icon, label, hint }, idx) => (
              <div key={label} className="animate-slide-up flex items-start gap-3" style={{ animationDelay: `${idx * 90}ms`, animationFillMode: "backwards" }}>
                <div className="flex flex-col items-center self-stretch">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                      idx === 0 ? "border-amber-400/40 bg-amber-400/10" : "border-white/10 bg-white/[0.03]"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${idx === 0 ? "text-amber-300" : "text-slate-400"}`} strokeWidth={1.75} />
                  </div>
                  {idx < PIPELINE.length - 1 && <div className="my-0.5 w-px flex-1 bg-gradient-to-b from-white/15 to-transparent" style={{ minHeight: "0.75rem" }} />}
                </div>
                <div className="pb-3.5 pt-1">
                  <p className="text-[13px] font-bold text-white">{label}</p>
                  <p className="text-[11px] text-slate-500">{hint}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 text-amber-300/60" strokeWidth={1.75} /> Server-enforced RBAC · append-only audit trail
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="animate-fade-in w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-900 shadow-[0_4px_14px_-4px_rgba(79,70,229,.55)]">
              <Microscope className="h-5 w-5 text-white" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-lg font-black leading-none tracking-tight text-slate-900">FLS ERP</h1>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">Enterprise Platform</p>
            </div>
          </div>

          <div className="card p-7 shadow-lift">
            <h2 className="mb-1 text-2xl font-black tracking-tight text-slate-900">Welcome back</h2>
            <p className="mb-7 text-sm text-slate-500">Sign in to continue to your workspace.</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={2} />
                  <input
                    type="email"
                    required
                    autoComplete="username"
                    className="field pl-10"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@fls.local"
                  />
                </div>
              </div>
              <div>
                <label className="label">Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={2} />
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    className="field pl-10 pr-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" strokeWidth={2} /> : <Eye className="h-4 w-4" strokeWidth={2} />}
                  </button>
                </div>
              </div>
              {error && <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">{error}</div>}
              <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
                {submitting ? "Signing in…" : "Sign In"}
                {!submitting && <ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-[11px] text-slate-400">© 2026 FLS ERP — Order Tracking, Packaging BOM &amp; RM Costing</p>
        </div>
      </div>
    </div>
  );
}
