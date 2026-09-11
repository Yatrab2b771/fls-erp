import { useState, type FormEvent } from "react";
import { ArrowRight, Beaker, ClipboardList, Eye, EyeOff, Lock, Mail, Microscope, ShieldCheck, ShoppingCart, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

// The four real phases an order passes through, in the order the
// departments actually touch it. "Send Back" used to sit here as a
// fourth step — it's an exception path any stage can take, not a phase
// of the flow, and giving it a quarter of the stepper overweighted a
// rejection while leaving out planning and procurement entirely (two
// whole modules of this app). It's stated where it belongs instead: on
// the production step, which is where a return actually gets used.
const PIPELINE = [
  { icon: ShoppingCart, label: "Order Intake", hint: "BD logs the brand's PO — each product becomes its own tracker" },
  { icon: ClipboardList, label: "Plan & Procure", hint: "Packaging BOM and RM costing raise what Purchase buys against" },
  { icon: Beaker, label: "Produce & Verify", hint: "Dispensing to packaging — QC gates hold, any stage can send back" },
  { icon: Truck, label: "Dispatch & Reconcile", hint: "Shipment, invoice, and what was consumed against what shipped" },
];

// What the platform actually enforces, stated plainly — the three claims
// an operations lead evaluating this asks about first. Kept to facts the
// system genuinely implements (see requireRole, the audit log, and the
// per-stage department gates), not marketing.
const ASSURANCES = ["Server-enforced RBAC", "Append-only audit trail", "Department-gated stages"];

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
      {/* Hero panel — the same indigo→graphite wash the Dashboard's own
          hero uses, so signing in and landing on the app read as one
          product rather than two designs. (This panel used to carry a
          gold accent while every button in the app behind it was indigo;
          one identity, stated once, is the whole point of this side.)
          Plain hex-stop inline gradient, not Tailwind's custom-property
          gradient utilities — some browser theme extensions reset
          --tw-gradient-* and wash the panel out to near-white. */}
      <div
        className="relative hidden overflow-hidden lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12 xl:w-1/2 xl:p-16"
        style={{ backgroundColor: "#0f172a", backgroundImage: "linear-gradient(160deg, #312e81 0%, #1e1b4b 42%, #0b1020 100%)" }}
      >
        {/* Fine hairline grid — barely-there texture, not decoration. Its
            own layer, so its background-size can't tile the gradient
            above it into a checkerboard. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
        {/* One soft light source, top-right, low-key */}
        <div className="pointer-events-none absolute -right-32 -top-32 h-[30rem] w-[30rem] rounded-full blur-3xl" style={{ backgroundColor: "rgba(129,140,248,0.14)" }} />
        <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(to top, rgba(0,0,0,.45), transparent 55%)" }} />

        <div className="animate-fade-in relative z-10 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] backdrop-blur">
            <Microscope className="h-5 w-5 text-brand-200" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-lg font-black leading-none tracking-tight text-white">FLS Mitr</p>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-300">Enterprise Platform</p>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h2 className="mb-4 text-3xl font-black leading-tight tracking-tight text-white xl:text-4xl">
            A brand's purchase order,
            <br />
            <span className="text-brand-300">tracked</span> to the day
            <br />
            it ships.
          </h2>
          <p className="mb-9 text-sm leading-relaxed text-slate-400">
            Planning, procurement, production and QC run off the same record — so what R&amp;D formulates is what Store dispenses, and what Dispatch ships is what the PO asked for.
          </p>

          {/* The four phases as frosted cards rather than a thin
              connector line and small grey text: each one now carries a
              real icon tile, and the step number is stated instead of
              implied by vertical position — a 2×2 grid reads at a glance
              where a tall stack of prose didn't. */}
          <div className="grid grid-cols-2 gap-3">
            {PIPELINE.map(({ icon: Icon, label, hint }, idx) => (
              <div
                key={label}
                className="animate-slide-up group relative overflow-hidden rounded-2xl border p-4 backdrop-blur-sm transition-colors duration-200"
                style={{
                  animationDelay: `${idx * 90}ms`,
                  animationFillMode: "backwards",
                  borderColor: "rgba(255,255,255,.09)",
                  backgroundColor: "rgba(255,255,255,.035)",
                }}
              >
                {/* Step number, top-right — these are ordered phases, and
                    a 2×2 grid alone doesn't say which comes first. Small
                    and set in the corner rather than a large ghosted
                    numeral behind the text, which collided with the
                    hint's third line on the longer cards. */}
                <span className="pointer-events-none absolute right-3.5 top-3.5 text-[10px] font-black tabular-nums tracking-wider text-white/25">
                  {String(idx + 1).padStart(2, "0")}
                </span>

                <div
                  className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border"
                  style={{ borderColor: "rgba(165,180,252,.28)", backgroundColor: "rgba(99,102,241,.16)" }}
                >
                  <Icon className="h-[17px] w-[17px] text-brand-200" strokeWidth={1.9} />
                </div>
                <p className="text-[13px] font-bold leading-tight text-white">{label}</p>
                <p className="mt-1 text-[11px] leading-snug text-slate-400">{hint}</p>
              </div>
            ))}
          </div>
        </div>

        {/* The assurances an operations lead actually asks about, as
            discrete items rather than one run-on line. */}
        <div className="relative z-10 flex flex-wrap items-center gap-x-5 gap-y-2">
          {ASSURANCES.map((claim) => (
            <p key={claim} className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-brand-400/70" strokeWidth={1.75} /> {claim}
            </p>
          ))}
        </div>
      </div>

      {/* Form panel — a faint brand-tinted wash rather than flat white, so
          the card sits on a surface instead of floating in a void. */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-12">
        <div className="pointer-events-none absolute -right-40 -top-40 h-[26rem] w-[26rem] rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.07)" }} />
        <div className="pointer-events-none absolute -bottom-40 -left-32 h-[24rem] w-[24rem] rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.06)" }} />

        <div className="animate-fade-in relative w-full max-w-[26rem]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-900 shadow-[0_4px_14px_-4px_rgba(79,70,229,.55)]">
              <Microscope className="h-5 w-5 text-white" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-lg font-black leading-none tracking-tight text-slate-900">FLS Mitr</h1>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">Enterprise Platform</p>
            </div>
          </div>

          <div className="card p-8 shadow-lift">
            <h2 className="text-2xl font-black tracking-tight text-slate-900">Welcome back</h2>
            <p className="mb-7 mt-1 text-sm text-slate-500">Sign in to continue to your workspace.</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label" htmlFor="login-email">
                  Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={2} />
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoComplete="username"
                    autoFocus
                    className="field pl-10"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@fls.local"
                  />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="login-password">
                  Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={2} />
                  <input
                    id="login-password"
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-slate-400 transition-colors hover:text-slate-600"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" strokeWidth={2} /> : <Eye className="h-4 w-4" strokeWidth={2} />}
                  </button>
                </div>
              </div>
              {/* role="alert" so a screen reader announces a failed sign-in
                  instead of leaving the user waiting on a button that
                  visually reset itself. */}
              {error && (
                <div role="alert" className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
                  {error}
                </div>
              )}
              <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
                {submitting ? "Signing in…" : "Sign In"}
                {!submitting && <ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
              </button>
            </form>

            <p className="mt-6 flex items-center justify-center gap-1.5 border-t border-slate-100 pt-5 text-[11px] font-semibold text-slate-400">
              <Lock className="h-3 w-3" strokeWidth={2.5} /> Access is scoped to your department's role
            </p>
          </div>

          <p className="mt-6 text-center text-[11px] text-slate-400">© 2026 FLS Mitr — Order Tracking, Packaging BOM &amp; RM Costing</p>
        </div>
      </div>
    </div>
  );
}
