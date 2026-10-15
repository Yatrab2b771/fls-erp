import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, type LucideIcon } from "lucide-react";

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Shown on hover - use it to say why an option is disabled. */
  title?: string;
  tone?: "default" | "primary" | "danger";
}

const TONE: Record<NonNullable<ActionMenuItem["tone"]>, string> = {
  default: "text-slate-700",
  primary: "text-emerald-700",
  danger: "text-rose-600",
};

/**
 * One "Action" button that opens a small menu of what can be done to a row. The menu is drawn over the page (so a table's
 * overflow never clips it) and opens upward when there is no room underneath. Renders a dash when there is nothing to do.
 */
export function ActionMenu({ items, busy = false }: { items: ActionMenuItem[]; busy?: boolean }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  if (items.length === 0) return <span className="text-slate-300">—</span>;

  const menuHeight = items.length * 36 + 8;
  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={busy}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const right = document.documentElement.clientWidth - rect.right;
          setPos(rect.bottom + menuHeight + 8 > window.innerHeight ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
        }}
      >
        Action <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
            <div className="fixed z-50 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-left shadow-lift" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => {
                      setPos(null);
                      item.onClick();
                    }}
                    className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-bold hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent ${TONE[item.tone ?? "default"]}`}
                  >
                    {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />} {item.label}
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
