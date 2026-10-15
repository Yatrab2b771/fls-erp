import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ChevronDown, MoreHorizontal } from "lucide-react";

// A row's actions in one dropdown. It is drawn on top of the page, outside the table, so the table's own scrolling never clips it.
export interface RowAction {
  label: string;
  icon?: ReactNode;
  /** Text colour class, e.g. "text-emerald-700". */
  tone?: string;
  onClick?: () => void;
  /** A link instead of a click. */
  to?: string;
  hidden?: boolean;
}

export function RowActionMenu({ actions, label = "Actions", width = "w-56", quiet = false }: { actions: RowAction[]; label?: string; width?: string; quiet?: boolean }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const shown = actions.filter((a) => !a.hidden);
  const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-slate-50";

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (pos) return setPos(null);
    const r = e.currentTarget.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    // Open upward when the button is near the bottom of the screen.
    setPos(r.bottom + 44 * shown.length + 12 > window.innerHeight ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  }

  return (
    <>
      {quiet ? (
        <button type="button" className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 ${pos ? "bg-slate-100 text-slate-800" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={!!pos} aria-label={label} title={label}>
          <MoreHorizontal className="h-4 w-4" strokeWidth={2.25} />
        </button>
      ) : (
        <button type="button" className="btn-ghost btn-sm" onClick={toggle} aria-haspopup="menu" aria-expanded={!!pos}>
          {label} <ChevronDown className={`h-3 w-3 transition-transform ${pos ? "rotate-180" : ""}`} strokeWidth={2.5} />
        </button>
      )}
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
            <div role="menu" className={`fixed z-50 ${width} overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-left shadow-lift`} style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
              {shown.map((a) =>
                a.to ? (
                  <Link key={a.label} to={a.to} role="menuitem" className={`${item} ${a.tone ?? "text-slate-700"}`} onClick={() => setPos(null)}>
                    {a.icon} {a.label}
                  </Link>
                ) : (
                  <button key={a.label} type="button" role="menuitem" className={`${item} ${a.tone ?? "text-slate-700"}`} onClick={() => { setPos(null); a.onClick?.(); }}>
                    {a.icon} {a.label}
                  </button>
                ),
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
