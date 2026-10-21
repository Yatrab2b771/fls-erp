import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, PackagePlus, Plus, Send, Trash2, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useInventoryItems, usePurchaseOrders } from "../lib/hooks";
import { useCreateExtraRequest, useExtraRequestOptions, useExtraRequests, useWithdrawExtraRequest, type ExtraRequestRow } from "../lib/extraHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

interface MaterialLine {
  key: number;
  category: "RM" | "PM";
  itemId: string;
  qty: string;
}

// Where an extra request stands, in words: with the Day Store, asked of the Warehouse, with PPIC, with Purchase, on order (ETA), then issued.
function trailOf(r: ExtraRequestRow): { label: string; tone: string } {
  if (r.stage === "ISSUED_TO_PLANT") return { label: "Issued to Plant", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  if (r.statusKey === "REJECTED") return { label: "Declined by Day Store", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  if (r.supplyStage === "ON_ORDER") return { label: `On order${r.purchaseEta ? `, due ${day(r.purchaseEta)}` : ""}`, tone: r.purchaseEtaLate ? "border-rose-200 bg-rose-50 text-rose-700" : "border-sky-200 bg-sky-50 text-sky-700" };
  if (r.supplyStage === "WITH_PURCHASE") return { label: "With Purchase", tone: "border-violet-200 bg-violet-50 text-violet-700" };
  if (r.supplyStage === "WITH_PPIC") return { label: "With PPIC", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (r.stage === "REQUESTED_FROM_WAREHOUSE") return { label: "Asked the Warehouse", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (r.stage === "ISSUED_TO_DAY_STORE") return { label: "At the Day Store", tone: "border-sky-200 bg-sky-50 text-sky-700" };
  return { label: r.statusKey === "PENDING" ? "With the Day Store" : "Approved, with the Day Store", tone: "border-slate-200 bg-slate-50 text-slate-600" };
}

// Production's Extra Material tile: ask the Plant's own Day Store for material that is not part of any plan, and follow it. The Day Store fills
// it from its shelf or asks the Warehouse; a shortage at the Warehouse goes to PPIC and Purchase by itself, and the material comes back down
// the same way once it arrives.
export function ExtraMaterialPage() {
  const { hasRole } = useAuth();
  const toast = useToast();
  const canAsk = hasRole("PRODUCTION");
  const { data, isLoading } = useExtraRequests();
  const { data: options } = useExtraRequestOptions({ enabled: canAsk });
  const create = useCreateExtraRequest();
  const withdraw = useWithdrawExtraRequest();
  const filters = useTileFilters();
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const { data: rmItems } = useInventoryItems("RM");
  const { data: pmItems } = useInventoryItems("PM");
  const { data: orders } = usePurchaseOrders({ enabled: canAsk });
  // One request can carry several materials; each line becomes its own request that the Day Store, Warehouse and Purchase follow separately.
  const [lines, setLines] = useState<MaterialLine[]>([{ key: 1, category: "RM", itemId: "", qty: "" }]);
  const nextKey = useRef(2);
  const setLine = (key: number, patch: Partial<MaterialLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const [neededBy, setNeededBy] = useState("");
  const [reason, setReason] = useState("");
  const [plantId, setPlantId] = useState("");
  const [refId, setRefId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const plants = options?.plants ?? [];
  const productOptions = useMemo(
    () => (orders ?? []).filter((o) => o.status === "APPROVED").flatMap((o) => (o.items ?? []).map((i) => ({ id: i.id, name: `${o.poNumber ?? "PO"} — ${i.productName}` }))),
    [orders],
  );

  const everyRow = data ?? [];
  const fields: FilterField[] = [
    { key: "item", label: "Item", options: distinct(everyRow.map((r) => r.itemName)) },
    { key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) },
    { key: "trail", label: "Where it is", options: distinct(everyRow.map((r) => trailOf(r).label.replace(/, due .*/, ""))) },
  ];
  const rows = everyRow.filter((r) => (!picked("item").length || picked("item").includes(r.itemName)) && (!picked("plant").length || picked("plant").includes(r.plantName ?? "")) && (!picked("trail").length || picked("trail").includes(trailOf(r).label.replace(/, due .*/, ""))));
  const pg = useClientPaging(rows);

  async function submit() {
    setError(null);
    const filled = lines.filter((l) => l.itemId || l.qty);
    if (filled.length === 0) return setError("Choose the item.");
    for (const [i, l] of filled.entries()) {
      if (!l.itemId) return setError(`Material ${i + 1}: choose the item.`);
      if (!(Number(l.qty) > 0)) return setError(`Material ${i + 1}: enter the quantity.`);
    }
    if (new Set(filled.map((l) => l.itemId)).size !== filled.length) return setError("The same item is added twice. Add it once with the total quantity.");
    if (reason.trim().length < 3) return setError("Say why it is needed.");
    if (plants.length > 1 && !plantId) return setError("Choose the Plant.");
    const sent = new Set<number>();
    try {
      for (const l of filled) {
        await create.mutateAsync({ itemId: l.itemId, requestedQty: Number(l.qty), reason: reason.trim(), neededBy: neededBy || undefined, plantId: plantId || (plants.length === 1 ? plants[0]!.id : undefined), purchaseOrderItemId: refId || undefined });
        sent.add(l.key);
      }
      toast.success(filled.length > 1 ? `Asked the Day Store for ${filled.length} materials. You can follow each in the list below.` : "Asked the Day Store. You can follow it in the list below.");
      setLines([{ key: nextKey.current++, category: "RM", itemId: "", qty: "" }]);
      setReason("");
      setNeededBy("");
      setRefId("");
    } catch (err) {
      // Keep only what was not sent, so a retry does not ask twice for the same material
      if (sent.size) setLines((ls) => ls.filter((l) => !sent.has(l.key)));
      setError((sent.size ? `${sent.size} sent, the rest did not go: ` : "") + (err instanceof ApiError ? err.message : "Could not send the request"));
    }
  }

  function download() {
    const lines = rows.map((r) => ({
      Requested: day(r.requestedAt),
      Item: r.itemName,
      Type: r.category,
      Unit: r.unit,
      "Requested Qty": r.requestedQty,
      "Issued Qty": r.issuedQty,
      Plant: r.plantName ?? "",
      "Needed By": day(r.neededBy),
      "Where It Is": trailOf(r).label,
      "For Product": r.refProduct ?? "",
      Reason: r.note ?? "",
      "Asked By": r.requestedBy,
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Extra material", "FLS Extra Material Requests", describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName("FLS_Extra_Material"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <PackagePlus className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Extra Material</h1>
            <p className="text-sm text-slate-500">Material you need that is not in any plan. It goes to your Plant's Day Store; if the Warehouse is short, PPIC and Purchase get it by themselves.</p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      {canAsk && (
        <div className="card space-y-3 p-4">
          <p className="label">Ask for material</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-2 sm:col-span-4">
              {lines.map((l, i) => (
                <div key={l.key} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-3">
                    {i === 0 && <label className="mb-0.5 block text-micro text-slate-400">Item and quantity</label>}
                    <div className="flex gap-1.5">
                      <select className="field !py-1.5 w-20 shrink-0 text-xs" value={l.category} onChange={(e) => setLine(l.key, { category: e.target.value as "RM" | "PM", itemId: "" })}>
                        <option value="RM">RM</option>
                        <option value="PM">PM</option>
                      </select>
                      <div className="min-w-0 flex-1">
                        <ItemPicker items={((l.category === "RM" ? rmItems : pmItems) ?? []).map((it) => ({ id: it.id, name: it.name, code: it.code }))} value={l.itemId} onChange={(v) => setLine(l.key, { itemId: v })} placeholder="— Select an item —" />
                      </div>
                      <input type="number" min="0" step="any" placeholder="Quantity" className="field !py-1.5 w-32 shrink-0 text-xs" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex items-center">
                    {lines.length > 1 && (
                      <button type="button" className="btn-ghost btn-sm" title="Remove this material" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button type="button" className="btn-ghost btn-sm" onClick={() => setLines((ls) => [...ls, { key: nextKey.current++, category: ls[ls.length - 1]?.category ?? "RM", itemId: "", qty: "" }])}>
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add another material
              </button>
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Needed by</label>
              <input type="date" className="field !py-1.5 text-xs" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
            </div>
            {plants.length > 1 && (
              <div>
                <label className="mb-0.5 block text-micro text-slate-400">Plant</label>
                <ItemPicker items={plants.map((p) => ({ id: p.id, name: p.name }))} value={plantId} onChange={setPlantId} placeholder="— Select a Plant —" clearable={false} />
              </div>
            )}
            <div className="sm:col-span-2">
              <label className="mb-0.5 block text-micro text-slate-400">Why is it needed?</label>
              <input className="field !py-1.5 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. trial batch, re-work, shortage on the line" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-0.5 block text-micro text-slate-400">For which product (optional)</label>
              <ItemPicker items={productOptions} value={refId} onChange={setRefId} placeholder="— Not for one product —" />
            </div>
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={submit}>
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {create.isPending ? "Sending…" : lines.filter((l) => l.itemId).length > 1 ? "Ask the Day Store for all" : "Ask the Day Store"}
            </button>
          </div>
        </div>
      )}

      <TileFilterBar filters={filters} tileKey="extra-material" fields={fields} dateLabel="Asked" hideDates />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackagePlus} title="No extra material requests" hint="What you ask for appears here, with where it is." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">Asked</th>
                  <th className="px-4 py-2.5">Item</th>
                  <th className="px-4 py-2.5 text-right">Quantity</th>
                  <th className="px-4 py-2.5 text-right">Issued</th>
                  <th className="px-4 py-2.5">Needed by</th>
                  <th className="px-4 py-2.5">Where it is</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const trail = trailOf(r);
                  return (
                    <tr key={r.id} className="border-b border-slate-50">
                      <td className="px-4 py-2.5 text-slate-600">{day(r.requestedAt)}</td>
                      <td className="whitespace-normal px-4 py-2.5 font-bold text-slate-800">
                        {r.itemName} <span className="font-normal text-slate-400">({r.category})</span>
                        <span className="block text-micro font-normal text-slate-500">
                          {r.note}
                          {r.refProduct ? ` · for ${r.refProduct}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                        {fmtQty(r.requestedQty)} {r.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{r.issuedQty ? fmtQty(r.issuedQty) : "—"}</td>
                      <td className={`px-4 py-2.5 ${r.overdue ? "font-bold text-rose-600" : "text-slate-600"}`}>
                        {day(r.neededBy)}
                        {r.overdue && <span className="block text-micro">Late</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`pill ${trail.tone}`}>{trail.label}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canAsk && r.statusKey === "PENDING" && r.issuedQty === 0 && (
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            title="Withdraw this request"
                            disabled={withdraw.isPending}
                            onClick={() => window.confirm(`Withdraw the request for ${r.itemName}?`) && withdraw.mutate(r.id, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not withdraw") })}
                          >
                            <Trash2 className="h-3 w-3" strokeWidth={2.25} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
