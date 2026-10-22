import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, PackagePlus, Plus, Send, Trash2, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useConfirmDelivery, useInventoryItems, useRejectDelivery } from "../lib/hooks";
import { ReceiveDialog, type ReceiveResult } from "../components/ReceiveDialog";
import { useCreateExtraRequest, useExtraBatches, useExtraRequests, useWithdrawExtraRequest, type ExtraRequestRow } from "../lib/extraHooks";
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

type Kind = "RM" | "PM" | "OTHER";
const KIND_LABEL: Record<Kind, string> = { RM: "RM", PM: "PM", OTHER: "Other" };
const UNITS = ["Kg", "Gm", "Ltr", "Ml", "Nos"];
const defaultUnit = (kind: Kind) => (kind === "RM" ? "Kg" : "Nos");

// One material of the request: an item from the list, or one typed in because it is not there (always typed for Other: gloves, masks, cleaning material ...)
interface MaterialLine {
  key: number;
  category: Kind;
  itemId: string;
  typed: boolean;
  name: string;
  unit: string;
  qty: string;
}
const blankLine = (key: number, category: Kind = "RM"): MaterialLine => ({ key, category, itemId: "", typed: category === "OTHER", name: "", unit: defaultUnit(category), qty: "" });

// Where an extra request stands, in words: with the Day Store, asked of the Warehouse, with PPIC, with Purchase, on order (ETA), then issued.
function trailOf(r: ExtraRequestRow): { label: string; tone: string } {
  if (r.onItsWay.length > 0) return { label: "On its way to the Plant", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (r.stage === "ISSUED_TO_PLANT") return { label: "Issued to Plant", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  if (r.statusKey === "REJECTED") return { label: "Declined by Store", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  if (r.supplyStage === "ON_ORDER") return { label: `On order${r.purchaseEta ? `, due ${day(r.purchaseEta)}` : ""}`, tone: r.purchaseEtaLate ? "border-rose-200 bg-rose-50 text-rose-700" : "border-sky-200 bg-sky-50 text-sky-700" };
  if (r.supplyStage === "WITH_PURCHASE") return { label: "With Purchase", tone: "border-violet-200 bg-violet-50 text-violet-700" };
  if (r.supplyStage === "WITH_PPIC") return { label: "With PPIC", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (r.stage === "REQUESTED_FROM_WAREHOUSE") return { label: "Asked the Warehouse", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (r.stage === "ISSUED_TO_DAY_STORE") return { label: "At the Store", tone: "border-sky-200 bg-sky-50 text-sky-700" };
  return { label: r.statusKey === "PENDING" ? "With the Store" : "Approved, with the Store", tone: "border-slate-200 bg-slate-50 text-slate-600" };
}

// Production's Extra Material tile: ask the Plant's own Store for material that is not part of the plan, for one batch (so it can be traced to
// the PO, the product and the batch it was used in), and follow it. The Store fills it from its shelf or asks the Warehouse; a shortage at the
// Warehouse goes to PPIC and Purchase by itself, and the material comes back down the same way once it arrives.
export function ExtraMaterialPage() {
  const { hasRole } = useAuth();
  const toast = useToast();
  const canAsk = hasRole("PRODUCTION");
  const { data, isLoading } = useExtraRequests();
  const { data: batchOptions } = useExtraBatches({ enabled: canAsk });
  const create = useCreateExtraRequest();
  const withdraw = useWithdrawExtraRequest();
  const confirmDelivery = useConfirmDelivery();
  const rejectDelivery = useRejectDelivery();
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const filters = useTileFilters();
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const { data: rmItems } = useInventoryItems("RM");
  const { data: pmItems } = useInventoryItems("PM");
  // One request can carry several materials; each line becomes its own request that the Day Store, Warehouse and Purchase follow separately.
  const [lines, setLines] = useState<MaterialLine[]>([blankLine(1)]);
  const nextKey = useRef(2);
  const setLine = (key: number, patch: Partial<MaterialLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const [neededBy, setNeededBy] = useState("");
  const [reason, setReason] = useState("");
  // The PO and product first, then one of its batches: the batch gives the Plant, so there is no Plant to choose
  const [refId, setRefId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const batches = useMemo(() => batchOptions ?? [], [batchOptions]);
  const productOptions = useMemo(() => [...new Map(batches.map((b) => [b.itemId, { id: b.itemId, name: `${b.poNumber ?? "PO"} — ${b.productName}` }])).values()], [batches]);
  const batchesOfProduct = batches.filter((b) => b.itemId === refId);
  const showPlant = new Set(batches.map((b) => b.plantId)).size > 1;

  const everyRow = data ?? [];
  const fields: FilterField[] = [
    { key: "item", label: "Item", options: distinct(everyRow.map((r) => r.itemName)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.refProduct)) },
    { key: "batch", label: "Batch", options: distinct(everyRow.map((r) => r.batchNo)) },
    { key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) },
    { key: "trail", label: "Where it is", options: distinct(everyRow.map((r) => trailOf(r).label.replace(/, due .*/, ""))) },
  ];
  const rows = everyRow.filter((r) => (!picked("item").length || picked("item").includes(r.itemName)) && (!picked("product").length || picked("product").includes(r.refProduct ?? "")) && (!picked("batch").length || picked("batch").includes(r.batchNo ?? "")) && (!picked("plant").length || picked("plant").includes(r.plantName ?? "")) && (!picked("trail").length || picked("trail").includes(trailOf(r).label.replace(/, due .*/, ""))));
  const pg = useClientPaging(rows);

  async function submit() {
    setError(null);
    const filled = lines.filter((l) => l.itemId || l.name.trim() || l.qty);
    if (filled.length === 0) return setError("Choose the item.");
    for (const [i, l] of filled.entries()) {
      if (l.typed ? l.name.trim().length < 2 : !l.itemId) return setError(`Material ${i + 1}: ${l.typed ? "type the material's name" : "choose the item"}.`);
      if (!(Number(l.qty) > 0)) return setError(`Material ${i + 1}: enter the quantity.`);
    }
    const sameKey = (l: MaterialLine) => (l.typed ? `${l.category}:${l.name.trim().toLowerCase()}` : l.itemId);
    if (new Set(filled.map(sameKey)).size !== filled.length) return setError("The same material is added twice. Add it once with the total quantity.");
    if (!refId) return setError("Choose the PO and product.");
    if (!batchId) return setError("Choose the batch this material is for.");
    if (reason.trim().length < 3) return setError("Say why it is needed.");
    const sent = new Set<number>();
    try {
      for (const l of filled) {
        await create.mutateAsync({ ...(l.typed ? { newItem: { category: l.category, name: l.name.trim(), unit: l.unit } } : { itemId: l.itemId }), requestedQty: Number(l.qty), reason: reason.trim(), neededBy: neededBy || undefined, productionBatchId: batchId });
        sent.add(l.key);
      }
      toast.success(filled.length > 1 ? `Asked the Store for ${filled.length} materials. You can follow each in the list below.` : "Asked the Store. You can follow it in the list below.");
      setLines([blankLine(nextKey.current++)]);
      setReason("");
      setNeededBy("");
      setRefId("");
      setBatchId("");
    } catch (err) {
      // Keep only what was not sent, so a retry does not ask twice for the same material
      if (sent.size) setLines((ls) => ls.filter((l) => !sent.has(l.key)));
      setError((sent.size ? `${sent.size} sent, the rest did not go: ` : "") + (err instanceof ApiError ? err.message : "Could not send the request"));
    }
  }

  // The Store dispensed it for the batch: Production says how much really arrived (less needs a reason), or refuses it (it goes back to the Store)
  async function receive(txnId: string, got: ReceiveResult) {
    try {
      await confirmDelivery.mutateAsync({ id: txnId, note: got.note, receivedQty: got.receivedQty });
      toast.success(got.receivedQty ? "Received. The shortage is recorded." : "Received. It is in your Plant's stock.");
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not receive it");
    }
  }
  async function refuse(txnId: string, reason: string) {
    try {
      await rejectDelivery.mutateAsync({ id: txnId, reason });
      toast.success("Refused. It goes back to the Store.");
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not refuse it");
    }
  }

  function download() {
    const lines = rows.map((r) => ({
      Requested: day(r.requestedAt),
      Item: r.itemName,
      Type: KIND_LABEL[r.category] ?? r.category,
      "New Material": r.newMaterial ? "Yes" : "",
      Unit: r.unit,
      "Requested Qty": r.requestedQty,
      "Issued Qty": r.issuedQty,
      "PO Number": r.refPoNumber ?? "",
      Product: r.refProduct ?? "",
      "Batch No": r.batchNo ?? "",
      Plant: r.plantName ?? "",
      "Needed By": day(r.neededBy),
      "Where It Is": trailOf(r).label,
      "GRN No": r.grnNos.join(", "),
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
            <p className="text-sm text-slate-500">Material you need for a batch that is not in its plan. It goes to your Plant's Store; if the Warehouse is short, PPIC and Purchase get it by themselves.</p>
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
                      <select className="field !py-1.5 w-20 shrink-0 text-xs" value={l.category} onChange={(e) => { const category = e.target.value as Kind; setLine(l.key, { category, itemId: "", typed: category === "OTHER" ? true : l.typed, unit: defaultUnit(category) }); }}>
                        {(["RM", "PM", "OTHER"] as Kind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <div className="min-w-0 flex-1">
                        {l.typed ? (
                          <input className="field !py-1.5 text-xs" value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} placeholder={l.category === "OTHER" ? "Type the material, e.g. Nitrile gloves" : "Type the new material's name"} />
                        ) : (
                          <ItemPicker items={((l.category === "RM" ? rmItems : pmItems) ?? []).map((it) => ({ id: it.id, name: it.name, code: it.code }))} value={l.itemId} onChange={(v) => setLine(l.key, { itemId: v })} placeholder="— Select an item —" />
                        )}
                      </div>
                      {l.typed && (
                        <select className="field !py-1.5 w-20 shrink-0 text-xs" value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} title="Unit">
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      )}
                      <input type="number" min="0" step="any" placeholder="Quantity" className="field !py-1.5 w-32 shrink-0 text-xs" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </div>
                    {l.category !== "OTHER" && (
                      <button type="button" className="mt-1 text-tiny font-bold text-brand-600 hover:underline" onClick={() => setLine(l.key, { typed: !l.typed, itemId: "", name: "" })}>
                        {l.typed ? "Pick from the item list instead" : "+ Add new material (not in the list)"}
                      </button>
                    )}
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
              <button type="button" className="btn-ghost btn-sm" onClick={() => setLines((ls) => [...ls, blankLine(nextKey.current++, ls[ls.length - 1]?.category ?? "RM")])}>
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add another material
              </button>
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Needed by</label>
              <input type="date" className="field !py-1.5 text-xs" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-0.5 block text-micro text-slate-400">PO and product</label>
              <ItemPicker items={productOptions} value={refId} onChange={(v) => { setRefId(v); setBatchId(""); }} placeholder="— Select the PO and product —" clearable={false} />
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Batch</label>
              <ItemPicker items={batchesOfProduct.map((b) => ({ id: b.batchId, name: showPlant && b.plantName ? `${b.batchNo} (${b.plantName})` : b.batchNo }))} value={batchId} onChange={setBatchId} placeholder={refId ? "— Select the batch —" : "— Choose the product first —"} clearable={false} />
            </div>
            <div className="sm:col-span-4">
              <label className="mb-0.5 block text-micro text-slate-400">Why is it needed?</label>
              <input className="field !py-1.5 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. re-work, shortage on the line, spillage" />
            </div>
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={submit}>
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {create.isPending ? "Sending…" : lines.filter((l) => l.itemId).length > 1 ? "Ask the Store for all" : "Ask the Store"}
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
                  <th className="px-4 py-2.5">PO / Product</th>
                  <th className="px-4 py-2.5">Batch</th>
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
                      <td className="px-4 py-2.5 text-slate-600">
                        <span className="font-bold text-slate-800">{r.refProduct ?? "—"}</span>
                        <span className="block text-micro text-slate-400">{r.refPoNumber ?? ""}</span>
                      </td>
                      <td className="px-4 py-2.5 font-mono font-bold text-orange-800">{r.batchNo ?? "—"}</td>
                      <td className="whitespace-normal px-4 py-2.5 font-bold text-slate-800">
                        {r.itemName} <span className="font-normal text-slate-400">({KIND_LABEL[r.category] ?? r.category})</span>
                        {r.newMaterial && <span className="ml-1.5 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 align-middle text-micro font-bold text-violet-700">New material</span>}
                        {r.grnNos.length > 0 && <span className="block font-mono text-micro font-bold text-slate-500">GRN {r.grnNos.join(", ")}</span>}
                        <span className="block text-micro font-normal text-slate-500">
                          {r.note}
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
                        {canAsk && r.onItsWay[0] && (
                          <>
                            <button type="button" className="btn-primary btn-sm" disabled={confirmDelivery.isPending || rejectDelivery.isPending} onClick={() => setReceivingId(r.id)}>
                              Receive
                            </button>
                            <ReceiveDialog
                              open={receivingId === r.id}
                              itemName={r.itemName}
                              sentQty={r.onItsWay[0].quantity}
                              unit={r.unit}
                              from="the Store"
                              busy={confirmDelivery.isPending || rejectDelivery.isPending}
                              onReceive={(got) => void receive(r.onItsWay[0]!.id, got)}
                              onRefuse={(reason) => void refuse(r.onItsWay[0]!.id, reason)}
                              onCancel={() => setReceivingId(null)}
                            />
                          </>
                        )}
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
