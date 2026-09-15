import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { Download, FileSpreadsheet, FileText, Package, Plus, ShoppingCart, Truck, Upload, UserPlus, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAllProductNames,
  useCreateCustomer,
  useCreatePurchaseOrder,
  useCreateSku,
  useCustomers,
  useImportPurchaseOrders,
  usePurchaseOrders,
  useReportCatalogMismatch,
  useSkus,
} from "../lib/hooks";
import { api } from "../lib/api";
import type { CreatePurchaseOrderPayload } from "../lib/hooks";
import { ApiError, downloadFile } from "../lib/api";
import type { PoBdPpicReportRow, ProductType } from "../lib/types";
import { exportBdPpicReport } from "../lib/purchaseOrdersExport";
import { downloadPurchaseOrderImportTemplate, parsePurchaseOrderWorkbook } from "../lib/purchaseOrdersImport";
import { findSimilarName } from "../lib/similarName";
import { ItemPicker } from "../components/ItemPicker";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { PoStatusBadge } from "../components/Badges";

const UNIT_OPTIONS = ["KG", "SKU", "Litres", "Other"];
const UNIT_ITEMS = UNIT_OPTIONS.map((u) => ({ id: u, name: u }));

interface LineItemDraft {
  productName: string;
  dosageForm: string;
  quantity: string;
  unit: string;
  volume: string;
  packSize: string;
  // No longer a form choice — BD doesn't classify this upfront anymore.
  // Always sent as EXISTING; PPIC's Generate button does the real
  // catalog match itself and only then discovers whether it's genuinely
  // new. See PurchaseOrderItem.productType.
  productType: ProductType;
}

function blankItem(): LineItemDraft {
  return { productName: "", dosageForm: "", quantity: "", unit: "KG", volume: "", packSize: "", productType: "EXISTING" };
}

// Same picker-with-"+ New" behavior as PickerWithAdd, minus its own
// <label> — every other field on a product line here uses a bare
// placeholder instead of a label, to keep the row compact.
function ProductPicker({
  options,
  value,
  onChange,
  onCreate,
  placeholder,
}: {
  options: { id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
  onCreate: (name: string) => Promise<{ id: string } | null>;
  placeholder: string;
}) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await onCreate(newName.trim());
      if (created) {
        onChange(created.id);
        setShowNew(false);
        setNewName("");
      }
    } finally {
      setCreating(false);
    }
  }

  return !showNew ? (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">
        <ItemPicker items={options} value={value} onChange={onChange} placeholder={placeholder} icon={Package} />
      </div>
      <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setShowNew(true)}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New
      </button>
    </div>
  ) : (
    <div className="flex gap-1.5">
      <input className="field min-w-0 flex-1" placeholder="New product name" value={newName} onChange={(e) => setNewName(e.target.value)} />
      <button type="button" className="btn-primary btn-sm shrink-0" disabled={creating} onClick={handleCreate}>
        {creating ? "Adding…" : "Add"}
      </button>
      <button type="button" className="btn-icon shrink-0" title="Cancel" onClick={() => setShowNew(false)}>
        <X className="h-3.5 w-3.5" strokeWidth={2.25} />
      </button>
    </div>
  );
}

export function PurchaseOrdersPage() {
  const { hasRole } = useAuth();
  const { data: orders, isLoading } = usePurchaseOrders();
  const canCreate = hasRole("BD");
  // BD & PPIC's own download report, matching their shared Excel
  // template — not the company-wide export every department used to see
  // (removed entirely for everyone else).
  const canDownloadBdPpicReport = hasRole("BD", "PPIC");
  const toast = useToast();

  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [bdPpicReportLoading, setBdPpicReportLoading] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const importOrders = useImportPurchaseOrders();

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.length, 0) ?? 0;
  // Approved but not yet fully shipped — same "in flight" idea the old
  // per-item batch count stood in for, just at the PO level now that
  // production detail isn't fetched as part of the list.
  const inProductionCount = orders?.filter((po) => po.status === "APPROVED" && !po.completion.isCompleted).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredOrders = orders?.filter((po) => !q || (po.poNumber ?? "").toLowerCase().includes(q) || po.customer.companyName.toLowerCase().includes(q));

  async function handleDownloadBdPpicReport() {
    setBdPpicReportLoading(true);
    try {
      const rows = await api<PoBdPpicReportRow[]>("/api/purchase-orders/reports/bd-ppic");
      if (!rows.length) return toast.error("Nothing to export — no purchase orders yet.");
      exportBdPpicReport(rows);
      toast.success(`Report downloaded — ${rows.length} row(s).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not load the report");
    } finally {
      setBdPpicReportLoading(false);
    }
  }

  // Bulk PO creation — BD's own PO system export, straight to created
  // (Draft) POs instead of retyping each one into the manual form.
  // Rows sharing a PO Number become one PO with several product lines.
  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parsePurchaseOrderWorkbook(buffer);
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Purchase Order import] No usable rows.", { fileName: file.name, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid PO Number + Customer + Product + Quantity + Unit together.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}).`,
        );
      }

      const result = await importOrders.mutateAsync(rows);
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      const existingNote = result.skippedExisting.length
        ? ` — ${result.skippedExisting.length} PO number${result.skippedExisting.length === 1 ? "" : "s"} already existed and ${result.skippedExisting.length === 1 ? "was" : "were"} skipped: ${result.skippedExisting.slice(0, 5).join(", ")}${result.skippedExisting.length > 5 ? ", …" : ""}`
        : "";
      toast.success(
        `Created ${result.posCreated} purchase order(s), ${result.itemsCreated} product line(s)${result.customersCreated ? `, ${result.customersCreated} new customer(s) added` : ""}${skippedNote}.${existingNote} All landed as Draft — review and approve each one.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import failed — check the file and try again.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Order Tracking</h1>
          <p className="text-sm text-slate-500">One PO can list several products — each becomes its own production tracker.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canDownloadBdPpicReport && (
            <button className="btn-ghost" onClick={handleDownloadBdPpicReport} disabled={bdPpicReportLoading} title="Download the BD & PPIC report — PO No., Dates, Customer, Product, Qty, Dispatch, Value and Ageing">
              <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> {bdPpicReportLoading ? "Loading…" : "Download Report"}
            </button>
          )}
          {canCreate && (
            <>
              <button className="btn-ghost" onClick={downloadPurchaseOrderImportTemplate} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" disabled={importOrders.isPending} onClick={() => importFileRef.current?.click()} title="Upload your own PO sheet — creates the PO(s) directly, no form to fill">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importOrders.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
              <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
                {showForm ? (
                  <X className="h-4 w-4" strokeWidth={2.5} />
                ) : (
                  <>
                    <Plus className="h-4 w-4" strokeWidth={2.5} /> New Purchase Order
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={ShoppingCart} label="Purchase Orders" value={orders?.length ?? 0} accent="rose" />
        <StatTile icon={Package} label="Products Queued" value={totalProducts} accent="brand" />
        <StatTile icon={Truck} label="Orders In Production" value={inProductionCount} accent="emerald" />
      </div>

      {showForm && <NewPurchaseOrderForm onDone={() => setShowForm(false)} />}

      {!isLoading && !!orders?.length && <SearchBar value={search} onChange={setSearch} placeholder="Search by PO number or customer…" />}

      {isLoading ? (
        <SkeletonRows rows={4} cols={5} />
      ) : !orders?.length ? (
        <EmptyState icon={ShoppingCart} title="No purchase orders yet" hint={canCreate ? "Create one above to get started." : "Ask BD to create the first one."} accent="rose" />
      ) : !filteredOrders?.length ? (
        <EmptyState icon={ShoppingCart} title="No matching purchase orders" hint="Try a different search." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Customer</th>
                  <th className="text-center">Products</th>
                  <th className="text-center" title="Calculated Packaging BOM / RM Costing plans, out of this PO's product count">BOM / Recipe</th>
                  <th>Order Date</th>
                  <th>Status</th>
                  <th>Completion</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((po) => (
                  <tr key={po.id}>
                    <td className="font-bold">
                      <Link to={`/purchase-orders/${po.id}`} className="text-brand-600 hover:underline">
                        {po.poNumber ?? po.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="text-slate-600">{po.customer.companyName}</td>
                    <td className="text-center font-mono font-bold text-slate-700">{po.items.length}</td>
                    <td className="text-center">
                      <PoBomRecipeStatus items={po.items} />
                    </td>
                    <td className="text-slate-500">{po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "—"}</td>
                    <td>
                      <PoStatusBadge status={po.status} />
                    </td>
                    <td>
                      {po.completion.isCompleted ? (
                        <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700" title={po.completion.completionDate ? `Shipped & confirmed ${new Date(po.completion.completionDate).toLocaleDateString()}` : undefined}>
                          {po.completion.daysTaken !== null ? `Completed in ${po.completion.daysTaken}d` : "Completed"}
                        </span>
                      ) : (
                        <span className="pill border-slate-200 bg-slate-50 text-slate-400">In progress</span>
                      )}
                    </td>
                    <td className="text-right">
                      <button
                        className="btn-icon hover:!bg-brand-50 hover:!text-brand-600"
                        onClick={() => downloadFile(`/api/purchase-orders/${po.id}/export.pdf`, `FLS_PO_${po.poNumber ?? po.id}.pdf`)}
                        title="Download PDF"
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Module Integration — Packaging BOM/RM Costing status surfaced right in
// Order Tracking itself, not just on the PO detail page's own Production
// Pipeline section (which this reuses the same "CALCULATED" definition
// from). A quick "is this PO planned yet" glance without opening every
// row.
function PoBomRecipeStatus({ items }: { items: { bomPlans?: { status: string }[]; rmPlans?: { status: string }[] }[] }) {
  if (!items.length) return <span className="text-slate-300">—</span>;
  const bomCount = items.filter((i) => i.bomPlans?.some((p) => p.status === "CALCULATED")).length;
  const rmCount = items.filter((i) => i.rmPlans?.some((p) => p.status === "CALCULATED")).length;
  const pillClass = (count: number) => (count === items.length ? "border-emerald-200 bg-emerald-50 text-emerald-700" : count === 0 ? "border-slate-200 bg-slate-50 text-slate-400" : "border-amber-200 bg-amber-50 text-amber-700");
  return (
    <div className="flex items-center justify-center gap-1">
      <span className={`pill text-[10px] ${pillClass(bomCount)}`} title="Products with a calculated Packaging BOM">
        BOM {bomCount}/{items.length}
      </span>
      <span className={`pill text-[10px] ${pillClass(rmCount)}`} title="Products with a calculated RM Costing (Recipe)">
        Recipe {rmCount}/{items.length}
      </span>
    </div>
  );
}

function NewPurchaseOrderForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const createOrder = useCreatePurchaseOrder();

  const [customerId, setCustomerId] = useState("");
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");

  const [poNumber, setPoNumber] = useState("");
  // Product Name suggests from the selected Customer's own catalog —
  // there's no separate Brand field any more (a Brand and the Customer
  // placing the PO are the same real company; see the Sku model's own
  // schema comment). BD can still add a genuinely new product on the
  // fly (same "+ New" pattern as Customer above): a bare Sku row, name
  // only, that R&D fills real specs into later.
  const createSku = useCreateSku();
  const reportMismatch = useReportCatalogMismatch();
  const { data: customerSkus } = useSkus(customerId || undefined);
  // Every product name across the *whole* catalog, not just this
  // customer's own — a brand-new customer wanting an already-manufactured
  // product (same formulation, different brand) can now just pick it here
  // instead of retyping it and waiting for a mismatch report round-trip.
  const { data: allProductNames } = useAllProductNames();
  const productOptions = useMemo(() => {
    const ownNames = (customerSkus ?? []).map((s) => s.productName);
    const merged = Array.from(new Set([...ownNames, ...(allProductNames ?? [])]));
    return merged.map((name) => ({ id: name, name }));
  }, [customerSkus, allProductNames]);
  const [orderDate, setOrderDate] = useState("");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [regulatoryBody, setRegulatoryBody] = useState("");
  // FSSAI/AYUSH are the two nearly every PO needs, but not the only
  // regulatory body that can come up — "+ New" adds one to this session's
  // own list on the spot, no separate admin screen, same as it works for
  // Day Store/Plant elsewhere. Nothing to persist server-side: the PO
  // just stores whatever string ends up here (see regulatoryBodyField in
  // purchase-orders.schemas.ts), so "creating" one is purely local state.
  const [regulatoryBodyOptions, setRegulatoryBodyOptions] = useState([
    { id: "FSSAI", name: "FSSAI" },
    { id: "AYUSH", name: "AYUSH" },
  ]);
  const [regulatoryStatus, setRegulatoryStatus] = useState("");
  const [items, setItems] = useState<LineItemDraft[]>([blankItem()]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // What's actually stopping submission right now, checked live as the
  // user fills the form — not just after they click Create. Uploading
  // the PO file is an attachment, not an auto-fill: it fills in nothing
  // else on this form, which is exactly what caused the confusion this
  // guards against (a file picked, everything else still blank, Create
  // clicked expecting it to "just work").
  const hasCustomer = showNewCustomer ? !!newCustomerName.trim() : !!customerId;
  const hasProduct = items.some((item) => item.productName.trim() && item.quantity);
  const missing: string[] = [];
  if (!hasCustomer) missing.push("a customer");
  if (!hasProduct) missing.push("at least one product with a name and quantity");
  const canSubmit = missing.length === 0;

  function updateItem(index: number, patch: Partial<LineItemDraft>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit() {
    setError(null);

    let finalCustomerId = customerId;
    if (showNewCustomer) {
      if (!newCustomerName.trim()) return setError("Enter the new customer's company name.");
      try {
        const created = await createCustomer.mutateAsync({ companyName: newCustomerName.trim() });
        finalCustomerId = created.id;
      } catch (err) {
        return setError(err instanceof ApiError ? err.message : "Could not create customer");
      }
    }
    if (!finalCustomerId) return setError("Select or create a customer first.");
    if (!expectedDeliveryDate) return setError("Enter the Expected Delivery Date.");

    const cleanItems: CreatePurchaseOrderPayload["items"] = [];
    for (const item of items) {
      if (!item.productName.trim() || !item.quantity) continue;
      cleanItems.push({
        productName: item.productName.trim(),
        dosageForm: item.dosageForm.trim() || undefined,
        quantity: Number(item.quantity),
        unit: item.unit,
        volume: item.volume ? Number(item.volume) : undefined,
        packSize: item.packSize.trim() || undefined,
        productType: item.productType,
      });
    }
    if (cleanItems.length === 0) return setError("Add at least one product with a name and quantity.");

    setSubmitting(true);

    // Two separate steps against two separate failure points: creating the
    // PO, then (only once that succeeded) attaching the file to it. Sharing
    // one try/catch used to blame a failed upload on "could not create
    // purchase order" — misleading, since the PO was already created by
    // that point and sat there in the background, undetected, ready to be
    // duplicated on a retry. Each step now reports its own outcome.
    let order: Awaited<ReturnType<typeof createOrder.mutateAsync>>;
    try {
      order = await createOrder.mutateAsync({
        customerId: finalCustomerId,
        poNumber: poNumber.trim() || undefined,
        orderDate: orderDate || undefined,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
        regulatoryBody: regulatoryBody || undefined,
        regulatoryStatus: regulatoryStatus || undefined,
        items: cleanItems,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create purchase order");
      setSubmitting(false);
      return;
    }

    // The PO exists now no matter what happens below — always close the
    // form and show it, rather than leaving the user staring at a form
    // that looks unsubmitted while a PO has actually already been created.
    if (file) {
      try {
        // Upload after creation — the PO needs an id to attach the file to,
        // so this can't go through useUploadPoDocument's per-PO hook here.
        const form = new FormData();
        form.append("file", file);
        await api(`/api/purchase-orders/${order.id}/documents`, { method: "POST", body: form, isFormData: true });
        toast.success(`Purchase order ${order.poNumber ?? order.id.slice(0, 8)} created with ${cleanItems.length} product(s) and the document attached.`);
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : "the document could not be attached";
        toast.error(`Purchase order ${order.poNumber ?? order.id.slice(0, 8)} was created, but ${reason}. Open it and attach the file from there.`);
      }
    } else {
      toast.success(`Purchase order ${order.poNumber ?? order.id.slice(0, 8)} created with ${cleanItems.length} product(s).`);
    }

    setSubmitting(false);
    onDone();
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="label">
            Customer <span className="text-rose-500">*</span>
          </label>
          {!showNewCustomer ? (
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <ItemPicker items={(customers ?? []).map((c) => ({ id: c.id, name: c.companyName }))} value={customerId} onChange={setCustomerId} placeholder="— Select a customer —" />
              </div>
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewCustomer(true)}>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input className="field" placeholder="Company name" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewCustomer(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="label">PO Number</label>
          <input className="field" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2026-XXXX" />
        </div>
        <div>
          <label className="label">Order Date</label>
          <input type="date" className="field" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div>
          <label className="label">
            Expected Delivery Date <span className="text-rose-500">*</span>
          </label>
          <input type="date" className="field" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
        </div>
        <div>
          <PickerWithAdd
            label="Regulatory Body"
            placeholder="FSSAI, AYUSH, …"
            options={regulatoryBodyOptions}
            value={regulatoryBody}
            onChange={setRegulatoryBody}
            onCreate={async (name) => {
              setRegulatoryBodyOptions((prev) => (prev.some((o) => o.id.toLowerCase() === name.toLowerCase()) ? prev : [...prev, { id: name, name }]));
              return { id: name };
            }}
          />
        </div>
        <div>
          <label className="label">Regulatory Status</label>
          <ItemPicker
            items={[
              { id: "Applied", name: "Applied" },
              { id: "Not Applied", name: "Not Applied" },
              { id: "Issued", name: "Issued" },
            ]}
            value={regulatoryStatus}
            onChange={setRegulatoryStatus}
          />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="label !mb-0">
            Products on this PO <span className="text-rose-500">*</span>
          </label>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            <Plus className="h-3 w-3" strokeWidth={2.5} /> Add More
          </button>
        </div>
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-6">
              <div className="sm:col-span-2">
                <ProductPicker
                  options={productOptions}
                  value={item.productName}
                  onChange={(v) => updateItem(i, { productName: v })}
                  placeholder={`Product ${i + 1} — search the full catalog`}
                  onCreate={async (name) => {
                    if (!customerId) return null;
                    // Same spelling-mismatch problem as Customer above, one
                    // level down — a typo'd product already in the
                    // catalog would otherwise silently get a duplicate.
                    const similar = findSimilarName(name, (customerSkus ?? []).map((s) => s.productName));
                    if (similar && !window.confirm(`Did you mean the existing product "${similar}"? Click Cancel to use that one, or OK to create "${name}" anyway.`)) {
                      const customerName = customers?.find((c) => c.id === customerId)?.companyName;
                      reportMismatch.mutate({ kind: "product", typedName: name, matchedName: similar, customerName });
                      return { id: similar };
                    }
                    await createSku.mutateAsync({ customerId, productName: name });
                    return { id: name };
                  }}
                />
              </div>
              <input className="field" placeholder="Dosage form (opt.)" value={item.dosageForm} onChange={(e) => updateItem(i, { dosageForm: e.target.value })} />
              <input
                className="field font-mono"
                type="number"
                min="0"
                step="any"
                placeholder="Quantity"
                value={item.quantity}
                onChange={(e) => updateItem(i, { quantity: e.target.value })}
              />
              <ItemPicker items={UNIT_ITEMS} value={item.unit} onChange={(v) => updateItem(i, { unit: v })} clearable={false} />
              <div className="flex gap-2">
                <input
                  className="field font-mono"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Volume (opt.)"
                  value={item.volume}
                  onChange={(e) => updateItem(i, { volume: e.target.value })}
                />
                {items.length > 1 && (
                  <button type="button" onClick={() => removeItem(i)} className="btn-icon shrink-0 hover:!bg-rose-50 hover:!text-rose-600" title="Remove product">
                    <X className="h-4 w-4" strokeWidth={2.25} />
                  </button>
                )}
              </div>
              <input
                className="field sm:col-span-2"
                placeholder="Pack size (opt., e.g. 1kg)"
                value={item.packSize}
                onChange={(e) => updateItem(i, { packSize: e.target.value })}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Upload the PO (photo or PDF)</label>
        <label className="btn-ghost inline-flex cursor-pointer">
          <Upload className="h-3.5 w-3.5" strokeWidth={2.25} />
          {file ? file.name : "Choose file…"}
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="hidden" />
        </label>
      </div>

      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
          <FileText className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      {/* Attaching a file doesn't fill in Customer/Product — this says so
          up front, before Create gets clicked and errors on it. */}
      {!canSubmit && !error && (
        <p className="text-xs font-semibold text-slate-400">Still needed to create this PO: {missing.join(" and ")}.</p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={submitting || !canSubmit}
          onClick={handleSubmit}
          title={!canSubmit ? `Still needed: ${missing.join(" and ")}` : undefined}
        >
          {submitting ? "Creating…" : "Create Purchase Order"}
        </button>
      </div>
    </div>
  );
}
