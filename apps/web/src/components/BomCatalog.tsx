import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Copy, ListPlus, Pencil, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { findSimilarName } from "../lib/similarName";
import { fetchBomVersion, useBomVersions, useCreateCustomer, useCreateSku, useCustomers, useInventoryItems, usePoProducts, useSkus, useUpdateCustomer, useUpdateSku, useUpdateSkuPackagingComponents } from "../lib/hooks";
import type { PmSnapshotShape } from "../lib/bomSnapshots";
import { CATALOG_SKU_SPEC_FIELDS, KNOWN_PACKAGING_TYPES, type CatalogSku } from "../lib/types";
import { ItemPicker } from "./ItemPicker";
import { useBomSlotDetail, useSaveBomSlot, type PmSlotComponent, type PmSlotHeader, type SlotName } from "../lib/bomSlotHooks";
import { SlotBanner, SlotExcelLoad, SlotStart, SlotSwitcher, type SlotChoice } from "./BomSlotSwitcher";
import type { ParsedPmProduct, ParsedRmRecipe } from "../lib/bomTemplateImport";
import { useToast } from "./Toast";
import { BomUploadBox } from "./BomUploadBox";
import { BomVersionBar } from "./BomVersionBar";
import { BomDownloadButtons, CustomerBomDownload } from "./BomDownloadButtons";
import { CustomerName } from "./CustomerName";

// Customer -> Product -> BOM. R&D browses, edits and adds BOMs here; PPIC sees the same, read-only.
// Costing is not part of this screen (it stays on the RM/costing side).

type BomStatus = "bom" | "old" | "none";

function hasOldSpec(sku: CatalogSku): boolean {
  return CATALOG_SKU_SPEC_FIELDS.some(({ key }) => {
    const v = sku[key];
    return typeof v === "string" && v.trim() !== "" && v.trim() !== "-";
  });
}

function skuStatus(sku: CatalogSku): BomStatus {
  if ((sku.packagingComponents ?? []).length > 0) return "bom";
  return hasOldSpec(sku) ? "old" : "none";
}

const STATUS_BADGE: Record<BomStatus, { label: string; cls: string }> = {
  bom: { label: "BOM ✓", cls: "bg-emerald-100 text-emerald-700" },
  old: { label: "Old spec", cls: "bg-amber-100 text-amber-700" },
  none: { label: "No BOM", cls: "bg-slate-100 text-slate-500" },
};

interface BomRow {
  type: string;
  itemId: string;
  quantity: string;
  unit: string;
  pmCode: string;
  // OV % as typed (2 = 2%). Blank = the default (2%, none for boxes).
  overage: string;
  spec: string;
  make: string;
  level: "" | "Primary" | "Secondary" | "Tertiary";
  // Old-spec text this row was suggested from; shown as a hint, never saved.
  hint?: string;
}

const blankRow = (): BomRow => ({ type: "", itemId: "", quantity: "", unit: "Nos", pmCode: "", overage: "", spec: "", make: "", level: "" });

const pctText = (f: number | null | undefined) => (f == null ? "" : String(Math.round(f * 10000) / 100));

function rowsFromSku(sku: CatalogSku): BomRow[] {
  return (sku.packagingComponents ?? []).map((c) => ({
    type: c.type,
    itemId: c.pmItemId ?? "",
    quantity: c.quantity != null ? String(c.quantity) : "",
    unit: c.unit,
    pmCode: c.pmCode ?? "",
    overage: pctText(c.overagePct),
    spec: c.spec ?? "",
    make: c.make ?? "",
    level: (c.packingLevel as BomRow["level"]) ?? "",
  }));
}

function rowsFromSnapshot(snap: PmSnapshotShape): BomRow[] {
  return snap.components.map((c) => ({
    type: c.type,
    itemId: c.pmItemId ?? "",
    quantity: c.quantity != null ? String(c.quantity) : "",
    unit: c.unit,
    pmCode: c.pmCode ?? "",
    overage: pctText(c.overagePct),
    spec: c.spec ?? "",
    make: c.make ?? "",
    level: (c.packingLevel as BomRow["level"]) ?? "",
  }));
}

const BOX_TYPE = /box|carton|shipper/i;
const PRIMARY_TYPE = /jar|pouch|sachet|tin|monocarton|scoop|wad/i;

// Same maths the plan engine uses (bom-engine.ts), shown beside each row so R&D sees the batch quantity.
function batchQty(r: BomRow, packs: number): { base: number; total: number } | null {
  const qty = Number(r.quantity);
  if (!(packs > 0) || !(qty > 0)) return null;
  const box = BOX_TYPE.test(r.type);
  const category = r.level === "Tertiary" ? 3 : r.level === "Primary" ? 1 : r.level === "Secondary" ? 2 : box ? 3 : PRIMARY_TYPE.test(r.type) ? 1 : 2;
  const rate = r.overage.trim() !== "" && Number(r.overage) >= 0 ? Number(r.overage) / 100 : category === 3 ? 0 : 0.02;
  const base = box ? Math.ceil(packs / qty) : packs * qty;
  return { base, total: base + Math.ceil(base * rate) };
}

// Old flat fields -> BOM rows (only the ones that are filled in).
function rowsFromOldSpec(sku: CatalogSku): BomRow[] {
  const val = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "-" ? v.trim() : "");
  const rows: BomRow[] = [];
  const add = (type: string, hint: string, quantity = "1") => rows.push({ ...blankRow(), type, quantity, hint });
  if (val(sku.jar)) add("Jar", val(sku.jar));
  if (val(sku.wadMm)) add("Wad", val(sku.wadMm));
  if (val(sku.scoopMl)) add("Scoop", val(sku.scoopMl));
  if (val(sku.silicaGelGms)) add(`Silica ${val(sku.silicaGelGms).replace(/\s*(gms?|g)\.?$/i, "")}gm`, val(sku.silicaGelGms), val(sku.silicaGelQtyNos) || "1");
  if (val(sku.authenticationSticker)) add("Authentication Label", val(sku.authenticationSticker));
  if (val(sku.capSticker)) add("Cap Sticker", val(sku.capSticker));
  if (val(sku.capLockSticker)) add("Cap Lock", val(sku.capLockSticker));
  if (val(sku.neckSleeve)) add("Neck Sleeves", val(sku.neckSleeve));
  if (val(sku.shrink)) add("Shrink Sleeves", val(sku.shrink));
  if (val(sku.innerPackaging)) add("Inner", val(sku.innerPackaging));
  if (val(sku.leaflet)) add("Leaflet", val(sku.leaflet));
  if (val(sku.corrugatedBoxMm)) add("Corrugated Box (Outer Shipper)", val(sku.corrugatedBoxMm), val(sku.packagingSizeNos) || "1");
  return rows;
}

export function BomCatalog({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();
  const createSku = useCreateSku();
  // The BOM tile links here with ?customer=<id>&product=<name> to open that product.
  const [searchParams] = useSearchParams();
  const wantedProduct = searchParams.get("product");
  const [customerId, setCustomerId] = useState(searchParams.get("customer") ?? "");
  const [skuId, setSkuId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const { data: skus, isLoading: skusLoading } = useSkus(customerId || undefined);
  // Products BD has put on POs for this customer that have no BOM row yet - shown as "No BOM, from a PO".
  const { data: poProducts } = usePoProducts(true);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [addingProduct, setAddingProduct] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [renamingCustomer, setRenamingCustomer] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const selectedCustomer = customers?.find((c) => c.id === customerId);
  // Open the product from the link: select its BOM row, or start one when the product only exists on a PO so far.
  const [openedFromLink, setOpenedFromLink] = useState(false);
  useEffect(() => {
    if (openedFromLink || !wantedProduct || !customerId || !skus) return;
    const hit = skus.find((s) => s.productName.trim().toLowerCase() === wantedProduct.trim().toLowerCase());
    setOpenedFromLink(true);
    if (hit) setSkuId(hit.id);
    else if (canEdit) createSku.mutateAsync({ customerId, productName: wantedProduct }).then((c) => setSkuId(c.id)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skus, wantedProduct, customerId, openedFromLink]);
  const selected = skus?.find((s) => s.id === skuId);

  const shownCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    return (customers ?? []).filter((c) => !q || c.companyName.toLowerCase().includes(q)).sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [customers, customerQuery]);
  const shownSkus = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    return (skus ?? []).filter((s) => !q || s.productName.toLowerCase().includes(q));
  }, [skus, productQuery]);
  const poOnly = useMemo(() => {
    const have = new Set((skus ?? []).map((s) => s.productName.trim().toLowerCase()));
    const q = productQuery.trim().toLowerCase();
    return (poProducts ?? []).filter((p) => p.customerId === customerId && !have.has(p.productName.trim().toLowerCase()) && (!q || p.productName.toLowerCase().includes(q)));
  }, [poProducts, skus, customerId, productQuery]);

  async function openPoProduct(productName: string) {
    if (!canEdit || !selectedCustomer) return;
    try {
      const created = await createSku.mutateAsync({ customerId: selectedCustomer.id, productName });
      setSkuId(created.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not open this product");
    }
  }

  async function handleAddCustomer() {
    const name = newCustomerName.trim();
    if (!name) return;
    const similar = findSimilarName(name, (customers ?? []).map((c) => c.companyName));
    if (similar && !window.confirm(`A very similar customer already exists: "${similar}". Add "${name}" as a new customer anyway?`)) return;
    try {
      const created = await createCustomer.mutateAsync({ companyName: name });
      toast.success(`"${created.companyName}" added. Now add its first product.`);
      setCustomerId(created.id);
      setSkuId("");
      setAddingCustomer(false);
      setNewCustomerName("");
      setAddingProduct(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add customer");
    }
  }

  async function handleAddProduct() {
    const name = newProductName.trim();
    if (!selectedCustomer || !name) return;
    const similar = findSimilarName(name, (skus ?? []).map((s) => s.productName));
    if (similar && !window.confirm(`"${selectedCustomer.companyName}" already has a very similar product: "${similar}". Add "${name}" anyway?`)) return;
    try {
      const created = await createSku.mutateAsync({ customerId: selectedCustomer.id, productName: name });
      toast.success(`"${created.productName}" added under "${selectedCustomer.companyName}". Fill its BOM on the right.`);
      setSkuId(created.id);
      setAddingProduct(false);
      setNewProductName("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add product");
    }
  }

  async function handleRenameCustomer() {
    if (!selectedCustomer || !renameValue.trim()) return;
    try {
      await updateCustomer.mutateAsync({ id: selectedCustomer.id, body: { companyName: renameValue.trim() } });
      toast.success(`Renamed to "${renameValue.trim()}".`);
      setRenamingCustomer(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename");
    }
  }

  return (
    <div>
      {canEdit && <BomUploadBox mode="PM" />}
      <h2 className="mb-2 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
        <Pencil className="h-3.5 w-3.5" /> {canEdit ? "Customer-wise Packaging BOM" : "Customer-wise Packaging BOM (view only)"}
      </h2>
      <div className="card grid grid-cols-1 md:grid-cols-[15rem_17rem_1fr]">
        {/* 1. Customers */}
        <div className="border-b border-slate-100 p-3.5 md:border-b-0 md:border-r">
          <div className="mb-2 flex items-center justify-between">
            <p className="label !mb-0">1. Customer</p>
            {canEdit && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setAddingCustomer((v) => !v)}>
                <Plus className="h-3 w-3" strokeWidth={2.5} /> New
              </button>
            )}
          </div>
          {addingCustomer && (
            <div className="mb-2 flex gap-1.5">
              <input className="field !py-1.5 min-w-0 flex-1 text-xs" placeholder="New customer name" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddCustomer()} />
              <button type="button" className="btn-primary btn-sm shrink-0" disabled={createCustomer.isPending} onClick={handleAddCustomer}>
                {createCustomer.isPending ? "…" : "Add"}
              </button>
            </div>
          )}
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
            <input className="field !py-1.5 !pl-7 text-xs" placeholder="Search customer" value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} />
          </div>
          <div className="max-h-[28rem] space-y-0.5 overflow-y-auto">
            {shownCustomers.length === 0 && <p className="px-2 py-3 text-tiny text-slate-400">No customer found.</p>}
            {shownCustomers.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.companyName}
                onClick={() => {
                  setCustomerId(c.id);
                  setSkuId("");
                  setRenamingCustomer(false);
                  setAddingProduct(false);
                  setProductQuery("");
                }}
                className={`block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs ${c.id === customerId ? "bg-violet-50 font-bold text-violet-700" : "text-slate-600 hover:bg-slate-50"}`}
              >
                {c.companyName}
              </button>
            ))}
          </div>
        </div>

        {/* 2. Products of the chosen customer */}
        <div className="border-b border-slate-100 p-3.5 md:border-b-0 md:border-r">
          <div className="mb-2 flex items-center justify-between">
            <p className="label !mb-0">2. Product</p>
            {canEdit && selectedCustomer && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setAddingProduct((v) => !v)}>
                <Plus className="h-3 w-3" strokeWidth={2.5} /> New
              </button>
            )}
          </div>
          {!selectedCustomer ? (
            <p className="px-1 py-3 text-tiny text-slate-400">Pick a customer first.</p>
          ) : (
            <>
              <CustomerBomDownload kind="pm" customerId={selectedCustomer.id} customerName={selectedCustomer.companyName} />
              <div className="mb-2 flex items-center gap-1.5">
                {!renamingCustomer ? (
                  <>
                    <p className="min-w-0 flex-1 truncate text-xs font-black text-slate-800" title={selectedCustomer.companyName}>
                      {selectedCustomer.companyName}
                    </p>
                    {canEdit && (
                      <button type="button" className="btn-icon h-6 w-6" title="Fix customer spelling" onClick={() => { setRenamingCustomer(true); setRenameValue(selectedCustomer.companyName); }}>
                        <Pencil className="h-3 w-3" strokeWidth={2.5} />
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <input className="field !py-1.5 min-w-0 flex-1 text-xs" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                    <button type="button" className="btn-primary btn-sm shrink-0" disabled={updateCustomer.isPending} onClick={handleRenameCustomer}>Save</button>
                    <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setRenamingCustomer(false)}>
                      <X className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </>
                )}
              </div>
              {addingProduct && (
                <div className="mb-2 flex gap-1.5">
                  <input className="field !py-1.5 min-w-0 flex-1 text-xs" placeholder="New product name" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddProduct()} />
                  <button type="button" className="btn-primary btn-sm shrink-0" disabled={createSku.isPending} onClick={handleAddProduct}>
                    {createSku.isPending ? "…" : "Add"}
                  </button>
                </div>
              )}
              {(skus ?? []).length > 6 && (
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                  <input className="field !py-1.5 !pl-7 text-xs" placeholder="Search product" value={productQuery} onChange={(e) => setProductQuery(e.target.value)} />
                </div>
              )}
              <div className="max-h-[26rem] space-y-0.5 overflow-y-auto">
                {skusLoading && <p className="px-2 py-3 text-tiny text-slate-400">Loading…</p>}
                {!skusLoading && (skus ?? []).length === 0 && poOnly.length === 0 && <p className="px-2 py-3 text-tiny text-slate-400">No product yet.{canEdit ? " Use “New” to add one." : ""}</p>}
                {shownSkus.map((s) => {
                  const badge = STATUS_BADGE[skuStatus(s)];
                  return (
                    <button
                      key={s.id}
                      type="button"
                      title={s.productName}
                      onClick={() => setSkuId(s.id)}
                      className={`flex w-full items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs ${s.id === skuId ? "bg-violet-50 font-bold text-violet-700" : "text-slate-600 hover:bg-slate-50"}`}
                    >
                      <span className="min-w-0 truncate">{s.productName}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro font-bold ${badge.cls}`}>{badge.label}</span>
                    </button>
                  );
                })}
                {poOnly.map((p) => (
                  <button
                    key={p.productName}
                    type="button"
                    title={canEdit ? "From a PO - click to start its BOM" : "From a PO - no BOM yet"}
                    disabled={!canEdit}
                    onClick={() => openPoProduct(p.productName)}
                    className="flex w-full items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-default"
                  >
                    <span className="min-w-0 truncate">{p.productName}</span>
                    <span className="flex shrink-0 gap-1">
                      <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-micro font-bold text-violet-600">From PO</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-micro font-bold ${STATUS_BADGE.none.cls}`}>{STATUS_BADGE.none.label}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 3. BOM */}
        <div className="min-w-0 p-4">
          {!selectedCustomer ? (
            <p className="text-xs text-slate-400">Pick a customer, then a product, to see its BOM.</p>
          ) : !selected ? (
            <p className="text-xs text-slate-400">Pick a product to see its BOM.</p>
          ) : (
            <BomEditorShell key={selected.id} sku={selected} customerId={customerId} canEdit={canEdit} siblingNames={(skus ?? []).filter((s) => s.id !== selected.id).map((s) => s.productName)} />
          )}
        </div>
      </div>
    </div>
  );
}

// Holds the version bar and decides what the editor below shows: the Active BOM, an older version read-only, or (V1 / V2) one of R&D's other versions.
function BomEditorShell(props: { sku: CatalogSku; customerId: string; canEdit: boolean; siblingNames: string[] }) {
  const { sku } = props;
  const [viewing, setViewing] = useState<number | null>(null);
  const [slot, setSlot] = useState<SlotChoice>("DISPLAY");
  const [startedEmpty, setStartedEmpty] = useState<SlotName | null>(null);
  const { data: slots } = useBomSlotDetail(props.customerId, sku.productName);
  const { data: versions } = useBomVersions("PM", sku.id);
  const activeVersion = versions?.[0]?.version ?? 0;
  const { data: snap } = useQuery({
    queryKey: ["bom-versions", "PM", sku.id, "snapshot", viewing],
    queryFn: () => fetchBomVersion<PmSnapshotShape>("PM", sku.id, viewing!),
    enabled: viewing != null,
  });
  const switcher = <SlotSwitcher value={slot} onChange={(v) => { setSlot(v); setStartedEmpty(null); }} detail={slots} half="pm" />;

  if (slot !== "DISPLAY") {
    const v = slots?.slots[slot];
    return (
      <div className="space-y-3">
        {switcher}
        {!slots ? (
          <p className="text-xs text-slate-400">Loading...</p>
        ) : v?.pm || startedEmpty === slot ? (
          <>
            <SlotBanner slot={slot} half="pm" />
            <BomEditor key={`${sku.id}:${slot}:${v?.updatedAt ?? "new"}`} {...props} slot={slot} slotComponents={v?.pm?.components ?? []} slotHeader={v?.pm?.header} />
          </>
        ) : (
          <SlotStart detail={slots} slot={slot} half="pm" canEdit={props.canEdit} onStartEmpty={() => setStartedEmpty(slot)} />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {switcher}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BomVersionBar kind="PM" entityId={sku.id} viewing={viewing} onView={setViewing} canRestore={props.canEdit} />
        <BomDownloadButtons kind="pm" id={sku.id} version={viewing} fileLabel={`FLS_PM_BOM_${sku.productName.replace(/[^A-Za-z0-9]+/g, "_")}${viewing ? `_v${viewing}` : ""}`} />
      </div>
      {viewing != null && !snap ? (
        <p className="text-xs text-slate-400">Loading version...</p>
      ) : (
        <BomEditor key={`${sku.id}:${viewing ?? "active"}:${activeVersion}`} {...props} snapshot={viewing != null ? snap!.snapshot : undefined} />
      )}
    </div>
  );
}

function BomEditor({ sku, customerId, canEdit: canEditProp, siblingNames, snapshot, slot, slotComponents, slotHeader }: { sku: CatalogSku; customerId: string; canEdit: boolean; siblingNames: string[]; snapshot?: PmSnapshotShape; slot?: SlotName; slotComponents?: PmSlotComponent[]; slotHeader?: PmSlotHeader }) {
  const toast = useToast();
  const canEdit = canEditProp && !snapshot; // an old version is only ever looked at
  const { data: customers } = useCustomers();
  const { data: pmItems } = useInventoryItems("PM");
  const updatePackaging = useUpdateSkuPackagingComponents(customerId);
  const updateSku = useUpdateSku(customerId);
  const saveSlot = useSaveBomSlot();
  const [rows, setRows] = useState<BomRow[]>(() => (slot ? rowsFromSnapshot({ header: {}, components: (slotComponents ?? []).map((c) => ({ ...c, unit: c.unit ?? "Nos" })) }) : snapshot ? rowsFromSnapshot(snapshot) : rowsFromSku(sku)));
  const src = slot ? slotHeader ?? sku : snapshot?.header ?? sku;
  const [header, setHeader] = useState({
    productCode: src.productCode ?? "",
    packSize: src.packSize ?? "",
    packingConfig: src.packingConfig ?? "",
    batchPacks: src.batchPacks != null ? String(src.batchPacks) : "",
  });
  const [useLevels, setUseLevels] = useState(() => rows.some((r) => r.level));
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyCustomerId, setCopyCustomerId] = useState(customerId);
  const [copySkuId, setCopySkuId] = useState("");
  const { data: copySkus } = useSkus(copying ? copyCustomerId : undefined);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(sku.productName);

  const itemOptions = useMemo(() => (pmItems ?? []).map((i) => ({ id: i.id, name: i.name, code: i.code })), [pmItems]);
  const itemById = useMemo(() => new Map((pmItems ?? []).map((i) => [i.id, i])), [pmItems]);
  const status = skuStatus(sku);
  const packs = Number(header.batchPacks) || 0;

  function setRow(idx: number, patch: Partial<BomRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function setHead(patch: Partial<typeof header>) {
    setHeader((h) => ({ ...h, ...patch }));
    setDirty(true);
  }
  function addRow() {
    setRows((prev) => [...prev, blankRow()]);
    setDirty(true);
  }
  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }
  function pickItem(idx: number, itemId: string) {
    const item = itemById.get(itemId);
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const unit = item?.unit && (!r.unit || r.unit === "Nos") ? item.unit : r.unit;
        return { ...r, itemId, unit, pmCode: item?.code ?? r.pmCode, type: r.type.trim() ? r.type : item?.name ?? r.type };
      }),
    );
    setDirty(true);
  }

  // A sheet loaded into a V1 / V2: its rows and pack details go into the editor (matched to the Store's PM items); nothing is saved yet.
  function loadSheet(sheet: ParsedPmProduct | ParsedRmRecipe) {
    const p = sheet as ParsedPmProduct;
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const byCode = new Map((pmItems ?? []).filter((i) => i.code).map((i) => [i.code!.trim().toLowerCase(), i]));
    const byName = new Map((pmItems ?? []).map((i) => [norm(i.name), i]));
    const used = new Map<string, number>();
    const incoming: BomRow[] = p.rows.map((r) => {
      const item = (r.code && byCode.get(r.code.trim().toLowerCase())) || byName.get(norm(r.name)) || null;
      const count = (used.get(r.name.toLowerCase()) ?? 0) + 1;
      used.set(r.name.toLowerCase(), count);
      return { type: count > 1 ? `${r.name} (${count})` : r.name, itemId: item?.id ?? "", quantity: String(r.qty), unit: r.uom || "Nos", pmCode: (item?.code ?? r.code) || "", overage: r.overage == null ? "0" : pctText(r.overage), spec: r.spec, make: r.make, level: r.level };
    });
    if (rows.length > 0 && !window.confirm(`Replace the ${rows.length} row(s) below with the ${incoming.length} row(s) of the sheet?`)) return;
    setRows(incoming);
    if (incoming.some((r) => r.level)) setUseLevels(true);
    setHeader({ productCode: p.productCode, packSize: p.packSize, packingConfig: p.packingConfig, batchPacks: p.batchPacks ? String(p.batchPacks) : header.batchPacks });
    setDirty(true);
  }

  function convertOldSpec() {
    const have = new Set(rows.map((r) => r.type.toLowerCase()));
    const fresh = rowsFromOldSpec(sku).filter((r) => !have.has(r.type.toLowerCase()));
    if (fresh.length === 0) return toast.error("Old spec has nothing new to add.");
    setRows((prev) => [...prev, ...fresh]);
    setDirty(true);
    toast.success(`${fresh.length} row(s) added from the old spec - pick the Warehouse item for each and Save.`);
  }

  function loadCopy() {
    const source = copySkus?.find((s) => s.id === copySkuId);
    if (!source) return;
    const incoming = rowsFromSku(source);
    if (incoming.length === 0) return toast.error(`"${source.productName}" has no BOM table yet.`);
    if (rows.length > 0 && !window.confirm(`Replace the ${rows.length} row(s) below with the BOM of "${source.productName}"?`)) return;
    setRows(incoming);
    if (incoming.some((r) => r.level)) setUseLevels(true);
    setDirty(true);
    setCopying(false);
    toast.success(`Copied ${incoming.length} row(s) from "${source.productName}" - check them and Save.`);
  }

  async function handleSave() {
    if (!slot && !(Number(header.batchPacks) > 0)) return toast.error("Batch quantity (packs) is required - enter how many packs the batch makes.");
    const cleaned = rows.filter((r) => r.type.trim() || r.itemId);
    const seen = new Set<string>();
    for (const r of cleaned) {
      const t = r.type.trim();
      if (!t) return toast.error("Every row needs a component name (e.g. Jar, Cap, Label).");
      if (seen.has(t.toLowerCase())) return toast.error(`"${t}" is added twice - each name can be in the BOM once.`);
      seen.add(t.toLowerCase());
      if (r.quantity.trim() && !(Number(r.quantity) >= 0)) return toast.error(`Quantity for "${t}" is not a valid number.`);
      if (r.overage.trim() && !(Number(r.overage) >= 0 && Number(r.overage) <= 100)) return toast.error(`OV % for "${t}" must be between 0 and 100.`);
    }
    if (slot) {
      if (cleaned.length === 0) return toast.error("Add at least one component.");
      try {
        await saveSlot.mutateAsync({
          slot,
          customerId,
          productName: sku.productName,
          pm: {
            header: { productCode: header.productCode.trim() || null, packSize: header.packSize.trim() || null, packingConfig: header.packingConfig.trim() || null, batchPacks: header.batchPacks.trim() ? Math.max(1, Math.round(Number(header.batchPacks))) : null },
            components: cleaned.map((r) => ({
              type: r.type.trim(),
              quantity: r.quantity.trim() ? Number(r.quantity) : null,
              unit: r.unit.trim() || "Nos",
              pmCode: r.pmCode.trim() || null,
              pmItemId: r.itemId || null,
              overagePct: r.overage.trim() ? Number(r.overage) / 100 : null,
              spec: r.spec.trim() || null,
              make: r.make.trim() || null,
              packingLevel: useLevels && r.level ? r.level : null,
            })),
          },
          note: note.trim() || undefined,
        });
        setDirty(false);
        setNote("");
        toast.success(`${slot} saved for "${sku.productName}". The Display BOM is unchanged.`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Could not save");
      }
      return;
    }
    try {
      await updatePackaging.mutateAsync({
        id: sku.id,
        note: note.trim() || undefined,
        header: {
          productCode: header.productCode.trim() || null,
          packSize: header.packSize.trim() || null,
          packingConfig: header.packingConfig.trim() || null,
          batchPacks: header.batchPacks.trim() ? Math.max(1, Math.round(Number(header.batchPacks))) : null,
        },
        components: cleaned.map((r) => ({
          type: r.type.trim(),
          quantity: r.quantity.trim() ? Number(r.quantity) : null,
          unit: r.unit.trim() || "Nos",
          pmCode: r.pmCode.trim() || undefined,
          pmItemId: r.itemId || null,
          overagePct: r.overage.trim() ? Number(r.overage) / 100 : null,
          spec: r.spec.trim() || null,
          make: r.make.trim() || null,
          packingLevel: useLevels && r.level ? r.level : null,
        })),
      });
      setDirty(false);
      setNote("");
      toast.success(`BOM saved for "${sku.productName}" as a new version.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function handleRename() {
    const name = nameValue.trim();
    if (!name || name === sku.productName) return setRenaming(false);
    const similar = findSimilarName(name, siblingNames);
    if (similar && !window.confirm(`"${sku.customerName}" already has a very similar product: "${similar}". Rename to "${name}" anyway?`)) return;
    try {
      await updateSku.mutateAsync({ id: sku.id, productName: name });
      toast.success(`Renamed to "${name}".`);
      setRenaming(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename");
    }
  }

  const unlinked = rows.filter((r) => r.type.trim() && !r.itemId).length;
  const colSpan = (useLevels ? 1 : 0) + 8 + (canEdit ? 1 : 0);

  return (
    <div className="space-y-4">
      <div>
        {!renaming ? (
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-black text-slate-900">{sku.productName}</h3>
            <span className={`rounded-full px-1.5 py-0.5 text-micro font-bold ${STATUS_BADGE[status].cls}`}>{STATUS_BADGE[status].label}</span>
            {canEdit && !slot && (
              <button type="button" className="btn-icon h-6 w-6" title="Fix product spelling" onClick={() => { setRenaming(true); setNameValue(sku.productName); }}>
                <Pencil className="h-3 w-3" strokeWidth={2.5} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex gap-1.5">
            <input className="field !py-1.5 min-w-0 flex-1 text-xs" value={nameValue} onChange={(e) => setNameValue(e.target.value)} />
            <button type="button" className="btn-primary btn-sm shrink-0" disabled={updateSku.isPending} onClick={handleRename}>Save</button>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setRenaming(false)}>
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </div>
        )}
        <p className="text-micro text-slate-400"><CustomerName name={sku.customerName} /></p>
      </div>

      {/* Header block of the PM BOM sheet */}
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 sm:grid-cols-4">
        {(
          [
            ["productCode", "Product code"],
            ["packSize", "Pack size (e.g. 120 g)"],
            ["packingConfig", "Packing configuration (e.g. 1*64 Jars)"],
            ["batchPacks", "Batch quantity (packs) *"],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
            <input
              className={`field !py-1.5 text-xs ${key === "batchPacks" && canEdit && !(Number(header.batchPacks) > 0) ? "!border-amber-400" : ""}`}
              type={key === "batchPacks" ? "number" : "text"}
              min={key === "batchPacks" ? 1 : undefined}
              value={header[key]}
              disabled={!canEdit}
              onChange={(e) => setHead({ [key]: e.target.value })}
            />
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCopying((v) => !v)}>
            <Copy className="h-3 w-3" strokeWidth={2.5} /> Copy BOM from another product
          </button>
          {slot && <SlotExcelLoad mode="pm" productName={sku.productName} onLoaded={loadSheet} />}
          {hasOldSpec(sku) && (
            <button type="button" className="btn-ghost btn-sm" onClick={convertOldSpec}>
              <Wand2 className="h-3 w-3" strokeWidth={2.5} /> Fill from old spec
            </button>
          )}
          <label className="ml-auto flex items-center gap-1 text-tiny text-slate-500">
            <input type="checkbox" checked={useLevels} onChange={(e) => { setUseLevels(e.target.checked); setDirty(true); }} /> Packing levels (Primary / Secondary / Tertiary)
          </label>
        </div>
      )}

      {copying && canEdit && (
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-[1fr_1fr_auto]">
          <ItemPicker
            items={(customers ?? []).map((c) => ({ id: c.id, name: c.companyName }))}
            value={copyCustomerId}
            onChange={(id) => { setCopyCustomerId(id); setCopySkuId(""); }}
            placeholder="- Customer -"
            clearable={false}
          />
          <ItemPicker
            items={(copySkus ?? []).filter((s) => s.id !== sku.id).map((s) => ({ id: s.id, name: s.productName }))}
            value={copySkuId}
            onChange={setCopySkuId}
            placeholder="- Product to copy from -"
          />
          <button type="button" className="btn-primary btn-sm" disabled={!copySkuId} onClick={loadCopy}>Load</button>
        </div>
      )}

      <div>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[52rem] text-left text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                {useLevels && <th className="w-24 px-2 py-2">Level</th>}
                <th className="px-2 py-2">Component</th>
                <th className="px-2 py-2">Warehouse item</th>
                <th className="px-2 py-2">Specification</th>
                <th className="px-2 py-2">Make</th>
                <th className="w-20 px-2 py-2">Qty / pack</th>
                <th className="w-14 px-2 py-2">Unit</th>
                <th className="w-16 px-2 py-2">OV %</th>
                <th className="w-24 px-2 py-2 text-right">Batch qty</th>
                {canEdit && <th className="w-8 px-1 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-3 py-6 text-center text-slate-400">
                    No BOM yet.{canEdit ? " Upload the Excel sheet above, add a row, copy from another product, or fill from the old spec." : ""}
                  </td>
                </tr>
              )}
              {rows.map((r, idx) => {
                const item = r.itemId ? itemById.get(r.itemId) : undefined;
                const calc = batchQty(r, packs);
                const box = BOX_TYPE.test(r.type);
                return (
                  <tr key={idx} className="align-top">
                    {useLevels && (
                      <td className="px-2 py-1.5">
                        <select className="field !py-1 text-xs" value={r.level} disabled={!canEdit} onChange={(e) => setRow(idx, { level: e.target.value as BomRow["level"] })}>
                          <option value="">-</option>
                          <option>Primary</option>
                          <option>Secondary</option>
                          <option>Tertiary</option>
                        </select>
                      </td>
                    )}
                    <td className="min-w-[9rem] px-2 py-1.5">
                      <input className="field !py-1 text-xs" list="bom-component-types" placeholder="e.g. Jar" value={r.type} disabled={!canEdit} onChange={(e) => setRow(idx, { type: e.target.value })} />
                      {r.hint && <p className="mt-0.5 text-micro text-amber-600">Old spec: {r.hint}</p>}
                    </td>
                    <td className="min-w-[13rem] px-2 py-1.5">
                      {canEdit ? (
                        <ItemPicker items={itemOptions} value={r.itemId} onChange={(id) => pickItem(idx, id)} placeholder="- Pick Warehouse item -" />
                      ) : (
                        <span className="text-slate-700">{item ? (item.code ? `${item.code} - ${item.name}` : item.name) : "-"}</span>
                      )}
                      {!r.itemId && r.type.trim() && (
                        <p className="mt-0.5 flex items-center gap-1 text-micro font-semibold text-amber-600">
                          <AlertTriangle className="h-3 w-3" /> Not in Warehouse list
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="field !py-1 text-xs" value={r.spec} disabled={!canEdit} onChange={(e) => setRow(idx, { spec: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="field !py-1 text-xs" value={r.make} disabled={!canEdit} onChange={(e) => setRow(idx, { make: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="field !py-1 text-right text-xs" type="number" min="0" step="any" placeholder="Qty" value={r.quantity} disabled={!canEdit} onChange={(e) => setRow(idx, { quantity: e.target.value })} />
                      {box && <p className="mt-0.5 text-micro text-slate-400">packs per box</p>}
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="field !py-1 text-xs" value={r.unit} disabled={!canEdit} onChange={(e) => setRow(idx, { unit: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="field !py-1 text-right text-xs" type="number" min="0" max="100" step="any" placeholder="auto" value={r.overage} disabled={!canEdit} onChange={(e) => setRow(idx, { overage: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-700">{calc ? calc.total.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "-"}</td>
                    {canEdit && (
                      <td className="px-1 py-1.5">
                        <button type="button" className="btn-icon h-6 w-6" title="Remove row" onClick={() => removeRow(idx)}>
                          <Trash2 className="h-3 w-3" strokeWidth={2.25} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="bom-component-types">
          {KNOWN_PACKAGING_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <p className="mt-1 text-micro text-slate-400">
          Qty / pack is what one finished pack needs (for a box or carton row it means packs per box). Batch qty = Qty x batch packs + OV % extra
          {packs > 0 ? ` (batch of ${packs.toLocaleString("en-IN")} packs)` : " - enter the batch quantity above to see it"}. Leave OV % blank for the default (2%, none for boxes); type 0 for none.
        </p>
        {canEdit && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={addRow}>
              <Plus className="h-3 w-3" strokeWidth={2.5} /> Add row
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {unlinked > 0 && <span className="text-micro text-amber-600">{unlinked} row(s) not linked to a Warehouse item</span>}
              <input className="field !h-7 !w-48 !py-0 text-xs" placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn-primary btn-sm" disabled={updatePackaging.isPending || saveSlot.isPending || !dirty} onClick={handleSave}>
                {updatePackaging.isPending || saveSlot.isPending ? "Saving..." : slot ? `Save ${slot}` : "Save BOM"}
              </button>
            </div>
          </div>
        )}
      </div>

      {!snapshot && !slot && <OldSpec sku={sku} customerId={customerId} canEdit={canEdit} />}
    </div>
  );
}

// The legacy flat spec (typed fields + custom columns from the old import) — kept, collapsed.
function OldSpec({ sku, customerId, canEdit }: { sku: CatalogSku; customerId: string; canEdit: boolean }) {
  const toast = useToast();
  const updateSku = useUpdateSku(customerId);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const { key } of CATALOG_SKU_SPEC_FIELDS) d[key] = (sku[key] as string | undefined) ?? "";
    return d;
  });
  const [extra, setExtra] = useState<[string, string][]>(() => Object.entries(sku.extra ?? {}).map(([k, v]) => [k, String(v)]));
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  async function handleSave() {
    try {
      await updateSku.mutateAsync({ id: sku.id, ...draft, extra: Object.fromEntries(extra.filter(([k]) => k.trim())) });
      toast.success(`Old spec saved for "${sku.productName}".`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <details className="rounded-xl border border-slate-200">
      <summary className="cursor-pointer select-none px-3 py-2 text-tiny font-bold uppercase tracking-wide text-slate-500">
        Old spec (previous format){hasOldSpec(sku) ? " — has values" : ""}
      </summary>
      <div className="space-y-3 border-t border-slate-100 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CATALOG_SKU_SPEC_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
              <input className="field !py-1.5 text-xs" value={draft[key] ?? ""} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div>
          <p className="label mb-1.5 flex items-center gap-1.5">
            <ListPlus className="h-3 w-3" /> Custom Fields
          </p>
          <div className="space-y-1.5">
            {extra.map(([key, value], idx) => (
              <div key={idx} className="flex gap-1.5">
                <input className="field !py-1.5 w-1/3 text-xs font-bold" value={key} disabled />
                <input className="field !py-1.5 flex-1 text-xs" value={value} disabled={!canEdit} onChange={(e) => setExtra((prev) => prev.map((p, i) => (i === idx ? [p[0], e.target.value] : p)))} />
                {canEdit && (
                  <button type="button" className="btn-icon shrink-0" title="Remove this field" onClick={() => setExtra((prev) => prev.filter((_, i) => i !== idx))}>
                    <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="flex gap-1.5">
                <input className="field !py-1.5 w-1/3 text-xs" placeholder="New field name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input className="field !py-1.5 flex-1 text-xs" placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
                <button
                  type="button"
                  className="btn-icon shrink-0"
                  title="Add this field"
                  onClick={() => {
                    if (!newName.trim()) return;
                    setExtra((prev) => [...prev, [newName.trim(), newValue.trim()]]);
                    setNewName("");
                    setNewValue("");
                  }}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </div>
            )}
          </div>
        </div>
        {canEdit && (
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" disabled={updateSku.isPending} onClick={handleSave}>
              {updateSku.isPending ? "Saving…" : "Save old spec"}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
