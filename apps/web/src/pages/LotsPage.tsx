import { useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, Boxes, Search } from "lucide-react";
import { useBatchTrace, useExpiringLots, useLotSearch, useLotTrace, useMissingExpiry, type LotStatus, type LotView } from "../lib/stockControlHooks";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useDebounced } from "../lib/useDebounced";
import { fmtQty } from "../lib/format";

const STATUS: Record<LotStatus, { label: string; cls: string }> = {
  OK: { label: "OK", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  EXPIRING: { label: "Expiring soon", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  EXPIRED: { label: "Expired", cls: "border-rose-200 bg-rose-50 text-rose-700" },
  RELEASED: { label: "Released after expiry", cls: "border-sky-200 bg-sky-50 text-sky-700" },
  NO_EXPIRY: { label: "No expiry date", cls: "border-slate-200 bg-slate-50 text-slate-600" },
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

function StatusPill({ status }: { status: LotStatus }) {
  return <span className={`pill ${STATUS[status].cls}`}>{STATUS[status].label}</span>;
}

type Tab = "expiring" | "find" | "missing";

// Lots & Recall: which deliveries are about to expire (at any place - Warehouse, Day Store or Plant), and - the question a recall
// asks - where did a given delivery go, and which deliveries went into a given batch.
export function LotsPage() {
  const [tab, setTab] = useState<Tab>("expiring");
  const [traceId, setTraceId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <Boxes className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Lots &amp; Recall</h1>
          <p className="text-sm text-slate-500">Expiry across every store, and where each delivery went. Stock is issued oldest-expiry first.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {([["expiring", "Expiring / Expired"], ["find", "Find a delivery (recall)"], ["missing", "No expiry date"]] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {traceId && <LotTrace receiptId={traceId} onClose={() => setTraceId(null)} />}
      {tab === "expiring" && <ExpiringTab onTrace={setTraceId} />}
      {tab === "find" && <FindTab onTrace={setTraceId} />}
      {tab === "missing" && <MissingTab onTrace={setTraceId} />}
    </div>
  );
}

function LotTable({ rows, showPlace, onTrace }: { rows: (LotView & { place?: string })[]; showPlace?: boolean; onTrace: (id: string) => void }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full whitespace-nowrap">
          <thead>
            <tr>
              <th>Item</th>
              {showPlace && <th>Where</th>}
              <th>Vendor</th>
              <th>GRN / Batch</th>
              <th>Expiry</th>
              <th className="text-right">Received</th>
              {rows.some((r) => r.remaining !== undefined) && <th className="text-right">Left there</th>}
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.receiptId}-${r.place ?? ""}-${i}`}>
                <td className="font-bold text-slate-800">{r.itemName}</td>
                {showPlace && <td className="text-slate-600">{r.place}</td>}
                <td className="text-slate-600">{r.vendorName ?? "—"}</td>
                <td className="text-slate-600">
                  {r.grnNo ?? "—"}
                  <span className="block text-micro text-slate-400">{r.batchNo ?? ""}</span>
                </td>
                <td className="text-slate-600">
                  {fmtDate(r.expiryDate)}
                  {r.daysToExpiry !== null && <span className={`block text-micro ${r.daysToExpiry < 0 ? "text-rose-600" : "text-slate-400"}`}>{r.daysToExpiry < 0 ? `${-r.daysToExpiry} days ago` : `in ${r.daysToExpiry} days`}</span>}
                </td>
                <td className="text-right font-mono">
                  {fmtQty(r.receivedQty)} {r.unit}
                </td>
                {rows.some((x) => x.remaining !== undefined) && <td className="text-right font-mono font-bold">{r.remaining !== undefined ? `${fmtQty(r.remaining)} ${r.unit}` : "—"}</td>}
                <td>
                  <StatusPill status={r.status} />
                </td>
                <td className="text-right">
                  <button className="btn-ghost btn-sm" onClick={() => onTrace(r.receiptId)}>
                    Where did it go?
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpiringTab({ onTrace }: { onTrace: (id: string) => void }) {
  const [days, setDays] = useState(60);
  const { data, isLoading } = useExpiringLots(days);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <AlarmClock className="h-4 w-4" /> Expired, or expiring within
        <select className="field !w-auto !py-1.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
        - only lots that still have material left.
      </div>
      {isLoading ? <SkeletonRows rows={4} cols={7} /> : !data?.length ? <EmptyState icon={AlarmClock} title="Nothing is expiring" hint={`No lot with material left expires in the next ${days} days.`} accent="emerald" /> : <LotTable rows={data} showPlace onTrace={onTrace} />}
    </div>
  );
}

function FindTab({ onTrace }: { onTrace: (id: string) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const { data, isLoading } = useLotSearch(dq);
  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input className="field !pl-9" placeholder="GRN, batch no., invoice, vendor or item…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      {dq.trim().length < 2 ? (
        <p className="text-xs text-slate-400">Type at least two characters.</p>
      ) : isLoading ? (
        <SkeletonRows rows={3} cols={7} />
      ) : !data?.length ? (
        <EmptyState icon={Search} title="No delivery matches" accent="slate" />
      ) : (
        <LotTable rows={data} onTrace={onTrace} />
      )}
    </div>
  );
}

function MissingTab({ onTrace }: { onTrace: (id: string) => void }) {
  const { data, isLoading } = useMissingExpiry();
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Accepted raw material with no expiry date can never expire in the system, so it is never caught. Enter the expiry date on these deliveries.</p>
      {isLoading ? <SkeletonRows rows={3} cols={7} /> : !data?.length ? <EmptyState icon={AlarmClock} title="Every accepted raw material delivery has an expiry date" accent="emerald" /> : <LotTable rows={data} onTrace={onTrace} />}
    </div>
  );
}

function LotTrace({ receiptId, onClose }: { receiptId: string; onClose: () => void }) {
  const { data, isLoading } = useLotTrace(receiptId);
  return (
    <div className="card space-y-3 border-brand-200 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label !mb-0">Where did this delivery go?</p>
          {data && (
            <p className="text-sm text-slate-700">
              <b>{data.lot.itemName}</b> - {data.lot.vendorName ?? "vendor not recorded"}, GRN {data.lot.grnNo ?? "—"}, batch {data.lot.batchNo ?? "—"}, expiry {fmtDate(data.lot.expiryDate)} - {fmtQty(data.lot.receivedQty)} {data.lot.unit} received
            </p>
          )}
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {isLoading ? (
        <SkeletonRows rows={3} cols={4} />
      ) : !data?.movements.length ? (
        <p className="text-xs text-slate-400">No movement of this delivery has a lot recorded yet (stock booked before lot tracking started is not traced).</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-modern w-full whitespace-nowrap">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th className="text-right">Qty</th>
                <th>Product / PO</th>
              </tr>
            </thead>
            <tbody>
              {data.movements.map((m, i) => (
                <tr key={i}>
                  <td className="text-slate-500">{fmtDate(m.at)}</td>
                  <td className="text-slate-600">{m.from ?? "Plant"}</td>
                  <td className="font-semibold text-slate-800">{m.batchId ? <Link className="text-brand-700 hover:underline" to={`/production-batches/${m.batchId}`}>{m.to}</Link> : m.to}</td>
                  <td className="text-right font-mono">
                    {fmtQty(m.quantity)} {data.lot.unit}
                  </td>
                  <td className="text-slate-600">{m.productName ? `${m.productName}${m.poNumber ? ` (${m.poNumber})` : ""} - ${m.customerName ?? ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.unaccountedQty > 0 && (
        <p className="text-xs text-slate-400">
          {fmtQty(data.unaccountedQty)} {data.lot.unit} of this delivery has no recorded movement - it is still in the Warehouse, or left before lot tracking began.
        </p>
      )}
    </div>
  );
}

/** The batch side of a recall: which deliveries went into one production batch. Used on the batch page. */
export function BatchLotsPanel({ batchId }: { batchId: string }) {
  const { data, isLoading } = useBatchTrace(batchId);
  if (isLoading) return <SkeletonRows rows={3} cols={5} />;
  if (!data || data.materials.length === 0) return <p className="text-xs text-slate-400">Nothing has been dispensed for this batch yet.</p>;
  return (
    <div className="space-y-3">
      {data.materials.map((m) => (
        <div key={m.itemId} className="rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-bold text-slate-800">
            {m.itemName} <span className="font-mono text-xs font-medium text-slate-500">- dispensed {fmtQty(m.dispensedQty)} {m.unit}</span>
          </p>
          {m.lots.length === 0 ? (
            <p className="text-xs text-slate-400">Lot not recorded for this material.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
              {m.lots.map((l) => (
                <li key={l.receiptId}>
                  <span className="font-mono">{fmtQty(l.usedQty)} {m.unit}</span> from {l.vendorName ?? "vendor not recorded"} - GRN {l.grnNo ?? "—"}, batch {l.batchNo ?? "—"}, mfg {fmtDate(l.mfgDate)}, expiry {fmtDate(l.expiryDate)}
                </li>
              ))}
              {m.lotUnknownQty > 0 && <li className="text-slate-400">{fmtQty(m.lotUnknownQty)} {m.unit} - lot not recorded</li>}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
