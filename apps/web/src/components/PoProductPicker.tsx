import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { apiPage } from "../lib/api";
import { useDebounced } from "../lib/useDebounced";
import { useDismiss } from "./MultiSelectDropdown";
import { CustomerName } from "./CustomerName";

interface ProductRow {
  po: { id: string; poNumber: string | null; customer: { companyName: string } };
  item: { id: string; productName: string };
}

export interface PickedProduct {
  itemId: string;
  label: string;
}

/**
 * Search the customer POs' products ("PO-1007", a customer, a product) and pick one - used to
 * say which PO / product a manual requirement is for. Searched on the server, so it stays
 * quick however many POs there are.
 */
export function PoProductPicker({ value, onChange }: { value: PickedProduct | null; onChange: (v: PickedProduct | null) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const root = useDismiss(open, () => setOpen(false));

  const { data, isLoading } = useQuery({
    queryKey: ["purchase-orders", "po-product-picker", q],
    queryFn: () => apiPage<ProductRow>(`/api/ppic/lists/total-products?page=1&pageSize=20${q ? `&search=${encodeURIComponent(q)}` : ""}`),
    enabled: open,
    placeholderData: (previous) => previous,
  });

  if (value) {
    return (
      <div className="flex h-10 items-center justify-between gap-2 rounded-xl border border-brand-300 bg-brand-50/50 px-3 text-body font-semibold text-brand-800">
        <span className="min-w-0 truncate" title={value.label}>
          {value.label}
        </span>
        <button type="button" aria-label="Remove the PO link" onClick={() => onChange(null)} className="rounded-full p-0.5 text-brand-400 transition hover:bg-brand-100 hover:text-rose-600">
          <X className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
      </div>
    );
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-10 w-full items-center justify-between rounded-xl border bg-white px-3 text-left text-body font-medium text-slate-400 shadow-soft transition hover:border-slate-300 ${open ? "border-brand-400 shadow-[0_0_0_4px_rgba(99,102,241,.12)]" : "border-slate-200"}`}
      >
        Not tied to a PO — search to pick one
        <Search className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-2 w-full min-w-[20rem] origin-top animate-scale-in overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift">
          <div className="border-b border-slate-100 p-2.5">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PO number, customer or product…"
              className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-medium outline-none transition focus:border-brand-400 focus:bg-white focus:shadow-[0_0_0_3px_rgba(99,102,241,.12)]"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {isLoading ? (
              <div className="space-y-2 p-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-8 w-full" />
                ))}
              </div>
            ) : (data?.rows.length ?? 0) === 0 ? (
              <p className="px-3 py-6 text-center text-xs font-medium text-slate-400">No PO product found</p>
            ) : (
              data!.rows.map(({ po, item }) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onChange({ itemId: item.id, label: `${po.poNumber ?? po.id.slice(0, 8)} · ${item.productName} · ${po.customer.companyName}` });
                    setOpen(false);
                    setSearch("");
                  }}
                  className="block w-full rounded-lg px-2.5 py-2 text-left text-body transition hover:bg-brand-50/70"
                >
                  <span className="font-bold text-slate-800">{po.poNumber ?? po.id.slice(0, 8)}</span> <span className="text-slate-700">· {item.productName}</span>
                  <span className="block text-tiny text-slate-400"><CustomerName name={po.customer.companyName} /></span>
                </button>
              ))
            )}
            {(data?.total ?? 0) > 20 && <p className="px-3 py-2 text-center text-tiny font-medium text-slate-400">Showing the first 20 of {data!.total} — type to narrow down</p>}
          </div>
        </div>
      )}
    </div>
  );
}
