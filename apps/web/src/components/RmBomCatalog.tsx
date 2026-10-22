import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Copy, FlaskConical, Plus, Search, Trash2 } from "lucide-react";
import { ApiError } from "../lib/api";
import { findSimilarName } from "../lib/similarName";
import { fetchBomVersion, useBomVersions, useCreateCustomer, useCreateSku, useCustomers, useImportRecipes, useInventoryItems, usePoProducts, useRecipe, useRecipes, useSkus } from "../lib/hooks";
import type { RecipeDetail, RecipeKind } from "../lib/types";
import type { RmSnapshotShape } from "../lib/bomSnapshots";
import { BomUploadBox } from "./BomUploadBox";
import { BomVersionBar } from "./BomVersionBar";
import { useBomSlotDetail, useSaveBomSlot, type RmSlotSnapshot, type SlotName } from "../lib/bomSlotHooks";
import { SlotBanner, SlotExcelLoad, SlotStart, SlotSwitcher, type SlotChoice } from "./BomSlotSwitcher";
import type { ParsedPmProduct, ParsedRmRecipe } from "../lib/bomTemplateImport";
import { BomDownloadButtons, CustomerBomDownload } from "./BomDownloadButtons";
import { ItemPicker } from "./ItemPicker";
import { useToast } from "./Toast";

// Customer -> Product -> recipe (RM BOM). R&D browses, edits and adds recipes here; PPIC sees the same, read-only.
// A recipe belongs to a product NAME (the same name on the PO), so the list of a customer is its products plus
// the product names BD has put on that customer's POs. No cost anywhere - quantities only.

interface Row {
  key: string;
  itemId: string;
  itemCode: string;
  name: string;
  brand: string;
  uom: string;
  qty: string;
  protein: string;
}
let rowSeq = 1;
const newRow = (kind: RecipeKind): Row => ({ key: `r${rowSeq++}`, itemId: "", itemCode: "", name: "", brand: "", uom: kind === "PER_UNIT" ? "mg" : "Kg", qty: "", protein: "" });

export function RmBomCatalog({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const createSku = useCreateSku();
  const { data: recipes } = useRecipes();
  const { data: poProducts } = usePoProducts(true);
  // The BOM tile links here with ?customer=<id>&product=<name> to open that product.
  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState(searchParams.get("customer") ?? "");
  const [productName, setProductName] = useState(searchParams.get("product") ?? "");
  const [customerQuery, setCustomerQuery] = useState("");
  const { data: skus } = useSkus(customerId || undefined);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [addingProduct, setAddingProduct] = useState(false);
  const [newProductName, setNewProductName] = useState("");

  const selectedCustomer = customers?.find((c) => c.id === customerId);
  // A recipe belongs to a customer + product name. A recipe with no customer is an older common one: it is never
  // used for a customer by itself, R&D chooses to copy it into that customer's own recipe.
  const recipeByName = useMemo(() => new Map((recipes ?? []).filter((r) => r.customerId === customerId).map((r) => [r.name.trim().toLowerCase(), r])), [recipes, customerId]);
  const commonByName = useMemo(() => new Map((recipes ?? []).filter((r) => !r.customerId).map((r) => [r.name.trim().toLowerCase(), r])), [recipes]);

  const shownCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    return (customers ?? []).filter((c) => !q || c.companyName.toLowerCase().includes(q)).sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [customers, customerQuery]);

  // Products of this customer: the ones in the BOM catalog plus the names from its POs.
  const products = useMemo(() => {
    const map = new Map<string, { name: string; fromPo: boolean }>();
    for (const s of skus ?? []) map.set(s.productName.trim().toLowerCase(), { name: s.productName, fromPo: false });
    for (const p of poProducts ?? []) {
      if (p.customerId !== customerId) continue;
      const k = p.productName.trim().toLowerCase();
      if (!map.has(k)) map.set(k, { name: p.productName, fromPo: true });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [skus, poProducts, customerId]);

  async function handleAddCustomer() {
    const name = newCustomerName.trim();
    if (!name) return;
    const similar = findSimilarName(name, (customers ?? []).map((c) => c.companyName));
    if (similar && !window.confirm(`A very similar customer already exists: "${similar}". Add "${name}" as a new customer anyway?`)) return;
    try {
      const created = await createCustomer.mutateAsync({ companyName: name });
      toast.success(`"${created.companyName}" added. Now add its first product.`);
      setCustomerId(created.id);
      setProductName("");
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
    const similar = findSimilarName(name, products.map((p) => p.name));
    if (similar && !window.confirm(`"${selectedCustomer.companyName}" already has a very similar product: "${similar}". Add "${name}" anyway?`)) return;
    try {
      const created = await createSku.mutateAsync({ customerId: selectedCustomer.id, productName: name });
      setProductName(created.productName);
      setAddingProduct(false);
      setNewProductName("");
      toast.success(`"${created.productName}" added. Fill its recipe on the right.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add product");
    }
  }

  return (
    <div>
      {canEdit && <BomUploadBox mode="RM" />}
      <h2 className="mb-2 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
        <FlaskConical className="h-3.5 w-3.5" /> {canEdit ? "Customer-wise RM BOM (recipes)" : "Customer-wise RM BOM (view only)"}
      </h2>
      <div className="card grid grid-cols-1 md:grid-cols-[15rem_17rem_1fr]">
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
              <button type="button" className="btn-primary btn-sm shrink-0" disabled={createCustomer.isPending} onClick={handleAddCustomer}>Add</button>
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
                onClick={() => { setCustomerId(c.id); setProductName(""); setAddingProduct(false); }}
                className={`block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs ${c.id === customerId ? "bg-amber-50 font-bold text-amber-700" : "text-slate-600 hover:bg-slate-50"}`}
              >
                {c.companyName}
              </button>
            ))}
          </div>
        </div>

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
              <p className="mb-2 truncate text-xs font-black text-slate-800" title={selectedCustomer.companyName}>{selectedCustomer.companyName}</p>
              <CustomerBomDownload kind="rm" customerId={selectedCustomer.id} customerName={selectedCustomer.companyName} />
              {addingProduct && (
                <div className="mb-2 flex gap-1.5">
                  <input className="field !py-1.5 min-w-0 flex-1 text-xs" placeholder="New product name" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddProduct()} />
                  <button type="button" className="btn-primary btn-sm shrink-0" disabled={createSku.isPending} onClick={handleAddProduct}>Add</button>
                </div>
              )}
              <div className="max-h-[26rem] space-y-0.5 overflow-y-auto">
                {products.length === 0 && <p className="px-2 py-3 text-tiny text-slate-400">No product yet.{canEdit ? " Use “New” to add one." : ""}</p>}
                {products.map((p) => {
                  const has = recipeByName.has(p.name.trim().toLowerCase());
                  const hasCommon = !has && commonByName.has(p.name.trim().toLowerCase());
                  return (
                    <button
                      key={p.name}
                      type="button"
                      title={p.name}
                      onClick={() => setProductName(p.name)}
                      className={`flex w-full items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs ${p.name === productName ? "bg-amber-50 font-bold text-amber-700" : "text-slate-600 hover:bg-slate-50"}`}
                    >
                      <span className="min-w-0 truncate">{p.name}</span>
                      <span className="flex shrink-0 gap-1">
                        {p.fromPo && !has && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-micro font-bold text-violet-600">From PO</span>}
                        <span className={`rounded-full px-1.5 py-0.5 text-micro font-bold ${has ? "bg-emerald-100 text-emerald-700" : hasCommon ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{has ? "Recipe ✓" : hasCommon ? "Common only" : "No recipe"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="min-w-0 p-4">
          {!selectedCustomer ? (
            <p className="text-xs text-slate-400">Pick a customer, then a product, to see its recipe.</p>
          ) : !productName ? (
            <p className="text-xs text-slate-400">Pick a product to see its recipe.</p>
          ) : (
            <RecipeShell key={`${customerId}:${productName}`} productName={productName} customerId={customerId} customerLabel={selectedCustomer.companyName} canEdit={canEdit} recipeId={recipeByName.get(productName.trim().toLowerCase())?.id ?? null} commonRecipeId={commonByName.get(productName.trim().toLowerCase())?.id ?? null} exactName={recipeByName.get(productName.trim().toLowerCase())?.name ?? productName} />
          )}
        </div>
      </div>
    </div>
  );
}

function RecipeShell(props: { productName: string; customerId: string; customerLabel: string; canEdit: boolean; recipeId: string | null; commonRecipeId: string | null; exactName: string }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [slot, setSlot] = useState<SlotChoice>("DISPLAY");
  const [startedEmpty, setStartedEmpty] = useState<SlotName | null>(null);
  const { data: slots } = useBomSlotDetail(props.customerId, props.exactName);
  const { data: versions } = useBomVersions("RM", props.recipeId ?? undefined);
  const activeVersion = versions?.[0]?.version ?? 0;
  const { data: snap } = useQuery({
    queryKey: ["bom-versions", "RM", props.recipeId, "snapshot", viewing],
    queryFn: () => fetchBomVersion<RmSnapshotShape>("RM", props.recipeId!, viewing!),
    enabled: viewing != null && !!props.recipeId,
  });
  const switcher = <SlotSwitcher value={slot} onChange={(v) => { setSlot(v); setStartedEmpty(null); }} detail={slots} half="rm" />;

  if (slot !== "DISPLAY") {
    const v = slots?.slots[slot];
    return (
      <div className="space-y-3">
        {switcher}
        {!slots ? (
          <p className="text-xs text-slate-400">Loading...</p>
        ) : v?.rm || startedEmpty === slot ? (
          <>
            <SlotBanner slot={slot} half="rm" />
            <RecipeEditor key={`${props.recipeId}:${slot}:${v?.updatedAt ?? "new"}`} {...props} slot={slot} slotInit={v?.rm ?? null} />
          </>
        ) : (
          <SlotStart detail={slots} slot={slot} half="rm" canEdit={props.canEdit} onStartEmpty={() => setStartedEmpty(slot)} />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {switcher}
      {props.recipeId && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BomVersionBar kind="RM" entityId={props.recipeId} viewing={viewing} onView={setViewing} canRestore={props.canEdit} />
          <BomDownloadButtons kind="rm" id={props.recipeId} version={viewing} customerName={props.customerLabel} fileLabel={`FLS_RM_BOM_${props.productName.replace(/[^A-Za-z0-9]+/g, "_")}${viewing ? `_v${viewing}` : ""}`} />
        </div>
      )}
      {viewing != null && !snap ? (
        <p className="text-xs text-slate-400">Loading version...</p>
      ) : (
        <RecipeEditor key={`${props.recipeId}:${viewing ?? "active"}:${activeVersion}`} {...props} snapshot={viewing != null ? snap!.snapshot : undefined} />
      )}
    </div>
  );
}

function RecipeEditor({ productName, customerId, customerLabel, canEdit: canEditProp, recipeId, commonRecipeId, exactName, snapshot, slot, slotInit }: { productName: string; customerId: string; customerLabel: string; canEdit: boolean; recipeId: string | null; commonRecipeId: string | null; exactName: string; snapshot?: RmSnapshotShape; slot?: SlotName; slotInit?: RmSlotSnapshot | null }) {
  const toast = useToast();
  const canEdit = canEditProp && !snapshot;
  const { data: detail, isLoading } = useRecipe(recipeId ?? undefined);
  const { data: rmItems } = useInventoryItems("RM");
  const { data: allRecipes } = useRecipes();
  const importRecipes = useImportRecipes();
  const saveSlot = useSaveBomSlot();

  const [kind, setKind] = useState<RecipeKind>("PER_KG");
  const [header, setHeader] = useState({ productCode: "", versionLabel: "", batchSize: "", avgUnitWeightMg: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyId, setCopyId] = useState("");
  const { data: copyDetail } = useRecipe(copying && copyId ? copyId : undefined);
  // R&D's choice: use the older common recipe of this product name as the starting point for this customer.
  const [useCommon, setUseCommon] = useState(false);
  const { data: commonDetail } = useRecipe(useCommon && commonRecipeId ? commonRecipeId : undefined);
  const { data: customers } = useCustomers();
  const customerName = useMemo(() => new Map((customers ?? []).map((c) => [c.id, c.companyName])), [customers]);
  useEffect(() => {
    if (useCommon && commonDetail) {
      applyCopy(commonDetail);
      setUseCommon(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCommon, commonDetail]);

  const itemOptions = useMemo(() => (rmItems ?? []).map((i) => ({ id: i.id, name: i.name, code: i.code })), [rmItems]);
  const itemByCode = useMemo(() => new Map((rmItems ?? []).filter((i) => i.code).map((i) => [i.code!.trim().toLowerCase(), i])), [rmItems]);
  const itemById = useMemo(() => new Map((rmItems ?? []).map((i) => [i.id, i])), [rmItems]);

  // Load the Active recipe (or the old version being looked at) into the editor.
  useEffect(() => {
    if (!rmItems && (recipeId || snapshot || slot)) return;
    // A V1 / V2 shows its own ingredients under the catalog recipe's header (batch size etc.).
    const slotSnap: RmSnapshotShape | undefined = slot
      ? { kind: slotInit?.kind ?? detail?.kind ?? "PER_KG", productCode: slotInit?.productCode ?? detail?.productCode ?? null, versionLabel: slotInit?.versionLabel ?? detail?.versionLabel ?? null, batchSize: slotInit?.batchSize ?? detail?.batchSize ?? null, avgUnitWeightMg: slotInit?.avgUnitWeightMg ?? detail?.avgUnitWeightMg ?? null, ingredients: (slotInit?.ingredients ?? []).map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode ?? undefined, gPerServing: i.gPerServing, proteinPct: i.proteinPct, uom: i.uom })) }
      : undefined;
    const src = (snapshot ?? slotSnap)
      ? { kind: (snapshot ?? slotSnap)!.kind ?? "PER_KG", productCode: (snapshot ?? slotSnap)!.productCode, versionLabel: (snapshot ?? slotSnap)!.versionLabel, batchSize: (snapshot ?? slotSnap)!.batchSize, avgUnitWeightMg: (snapshot ?? slotSnap)!.avgUnitWeightMg, ingredients: (snapshot ?? slotSnap)!.ingredients.map((i) => ({ ...i, itemCode: i.itemCode ?? null })) }
      : detail
        ? { kind: detail.kind ?? "PER_KG", productCode: detail.productCode, versionLabel: detail.versionLabel, batchSize: detail.batchSize, avgUnitWeightMg: detail.avgUnitWeightMg, ingredients: detail.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode, gPerServing: i.gPerServing, proteinPct: i.proteinPct, uom: i.uom })) }
        : null;
    if (!src) {
      if (!recipeId) { setKind("PER_KG"); setRows([newRow("PER_KG")]); }
      return;
    }
    setKind(src.kind);
    setHeader({ productCode: src.productCode ?? "", versionLabel: src.versionLabel ?? "", batchSize: src.batchSize != null ? String(src.batchSize) : "", avgUnitWeightMg: src.avgUnitWeightMg != null ? String(src.avgUnitWeightMg) : "" });
    setRows(
      src.ingredients.map((i) => {
        const item = i.itemCode ? itemByCode.get(i.itemCode.trim().toLowerCase()) : undefined;
        return { key: `r${rowSeq++}`, itemId: item?.id ?? "", itemCode: i.itemCode ?? "", name: i.name, brand: i.brand, uom: i.uom ?? (src.kind === "PER_UNIT" ? "mg" : "Kg"), qty: String(i.gPerServing), protein: i.proteinPct ? String(i.proteinPct > 1 ? i.proteinPct : i.proteinPct * 100) : "" };
      }),
    );
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, snapshot, rmItems?.length]);

  function setRow(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function pickItem(key: string, itemId: string) {
    const item = itemById.get(itemId);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, itemId, itemCode: item?.code ?? r.itemCode, name: item?.name ?? r.name } : r)));
    setDirty(true);
  }
  function changeKind(next: RecipeKind) {
    setKind(next);
    setRows((prev) => prev.map((r) => ({ ...r, uom: next === "PER_UNIT" ? "mg" : "Kg" })));
    setDirty(true);
  }
  function loadCopy() {
    if (copyDetail) applyCopy(copyDetail);
  }
  function applyCopy(copyDetail: RecipeDetail) {
    if (rows.some((r) => r.name.trim() && Number(r.qty) > 0) && !window.confirm(`Replace the rows below with the recipe of "${copyDetail.name}"?`)) return;
    const k = copyDetail.kind ?? "PER_KG";
    setKind(k);
    setRows(copyDetail.ingredients.map((i) => ({ key: `r${rowSeq++}`, itemId: itemByCode.get((i.itemCode ?? "").trim().toLowerCase())?.id ?? "", itemCode: i.itemCode ?? "", name: i.name, brand: i.brand, uom: i.uom ?? (k === "PER_UNIT" ? "mg" : "Kg"), qty: String(i.gPerServing), protein: i.proteinPct ? String(i.proteinPct > 1 ? i.proteinPct : i.proteinPct * 100) : "" })));
    setDirty(true);
    setCopying(false);
    toast.success(`Copied ${copyDetail.ingredients.length} row(s) from "${copyDetail.name}" - check the quantities, then Save.`);
  }

  // A sheet loaded into a V1 / V2: its ingredients and header go into the editor (matched to the Store's RM items); nothing is saved yet.
  function loadSheet(sheet: ParsedPmProduct | ParsedRmRecipe) {
    const p = sheet as ParsedRmRecipe;
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const byName = new Map((rmItems ?? []).map((i) => [norm(i.name), i]));
    if (rows.some((r) => r.name.trim() && Number(r.qty) > 0) && !window.confirm(`Replace the rows below with the ${p.rows.length} ingredient(s) of the sheet?`)) return;
    const k: RecipeKind = p.kind === "RM_UNIT" ? "PER_UNIT" : "PER_KG";
    setKind(k);
    setRows(
      p.rows.map((r) => {
        const item = (r.code && itemByCode.get(r.code.trim().toLowerCase())) || byName.get(norm(r.name)) || null;
        return { key: `r${rowSeq++}`, itemId: item?.id ?? "", itemCode: (item?.code ?? r.code) || "", name: item?.name ?? r.name, brand: r.make || "Approved Vendor", uom: r.uom || (k === "PER_UNIT" ? "mg" : "Kg"), qty: String(r.qty), protein: "" };
      }),
    );
    setHeader({ productCode: p.productCode, versionLabel: p.versionLabel, batchSize: p.batchSize != null ? String(p.batchSize) : header.batchSize, avgUnitWeightMg: p.avgUnitWeightMg != null ? String(p.avgUnitWeightMg) : header.avgUnitWeightMg });
    setDirty(true);
  }

  async function handleSave() {
    if (!slot && !(Number(header.batchSize) > 0)) return toast.error(`Batch size is required - enter the batch ${kind === "PER_UNIT" ? "in gummies" : "in Kg"}.`);
    const usable = rows.filter((r) => r.name.trim() && Number(r.qty) > 0);
    if (usable.length === 0) return toast.error("Add at least one ingredient with a name and a quantity greater than 0.");
    if (slot) {
      try {
        await saveSlot.mutateAsync({
          slot,
          customerId,
          productName: exactName,
          rm: { kind, productCode: header.productCode.trim() || null, versionLabel: header.versionLabel.trim() || null, batchSize: Number(header.batchSize) > 0 ? Number(header.batchSize) : null, avgUnitWeightMg: kind === "PER_UNIT" && Number(header.avgUnitWeightMg) > 0 ? Number(header.avgUnitWeightMg) : null, ingredients: usable.map((r) => ({ name: r.name.trim(), brand: r.brand.trim() || "Approved Vendor", itemCode: r.itemCode.trim() || undefined, gPerServing: Number(r.qty), proteinPct: Math.min(1, (Number(r.protein) || 0) > 1 ? (Number(r.protein) || 0) / 100 : Number(r.protein) || 0), uom: r.uom || undefined })) },
          note: note.trim() || undefined,
        });
        setDirty(false);
        setNote("");
        toast.success(`${slot} saved for "${productName}". The Display BOM is unchanged.`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : `Could not save ${slot}`);
      }
      return;
    }
    try {
      await importRecipes.mutateAsync([
        {
          name: exactName,
          customerId,
          kind,
          productCode: header.productCode.trim() || null,
          versionLabel: header.versionLabel.trim() || null,
          batchSize: Number(header.batchSize) > 0 ? Number(header.batchSize) : null,
          avgUnitWeightMg: kind === "PER_UNIT" && Number(header.avgUnitWeightMg) > 0 ? Number(header.avgUnitWeightMg) : null,
          note: note.trim() || undefined,
          ingredients: usable.map((r) => ({ name: r.name.trim(), brand: r.brand.trim() || "Approved Vendor", itemCode: r.itemCode.trim() || undefined, gPerServing: Number(r.qty), proteinPct: Number(r.protein) || 0, uom: r.uom || undefined })),
        },
      ]);
      setDirty(false);
      setNote("");
      toast.success(`Recipe of "${productName}" saved as a new version.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save this recipe");
    }
  }

  if (recipeId && isLoading && !snapshot) return <p className="text-xs text-slate-400">Loading...</p>;

  const unit = kind === "PER_UNIT";
  const batch = Number(header.batchSize) || 0;
  const qtyOf = (r: Row) => Number(r.qty) || 0;
  const batchOf = (r: Row) => (unit ? (qtyOf(r) * batch) / 1000 : qtyOf(r) * batch); // g per batch for gummies, Kg for per-Kg
  const sumQty = rows.reduce((a, r) => a + qtyOf(r), 0);
  const sumBatch = rows.reduce((a, r) => a + batchOf(r), 0);
  const unlinked = rows.filter((r) => r.name.trim() && !r.itemId).length;
  const kgOk = !unit && Math.abs(sumQty - 1) < 0.0005;
  const fmt = (n: number, d: number) => n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-black text-slate-900">{productName}</h3>
          <span className={`rounded-full px-1.5 py-0.5 text-micro font-bold ${recipeId ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{recipeId ? "Recipe ✓" : "No recipe"}</span>
        </div>
        <p className="text-micro text-slate-400">{customerLabel}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 sm:grid-cols-4">
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Product code</label>
          <input className="field !py-1.5 text-xs" value={header.productCode} disabled={!canEdit} onChange={(e) => { setHeader((h) => ({ ...h, productCode: e.target.value })); setDirty(true); }} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Trial / version no.</label>
          <input className="field !py-1.5 text-xs" value={header.versionLabel} disabled={!canEdit} onChange={(e) => { setHeader((h) => ({ ...h, versionLabel: e.target.value })); setDirty(true); }} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Recipe type</label>
          <select className="field !py-1.5 text-xs" value={kind} disabled={!canEdit} onChange={(e) => changeKind(e.target.value as RecipeKind)}>
            <option value="PER_KG">Quantity per Kg (powder, bar)</option>
            <option value="PER_UNIT">Milligrams per gummy</option>
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">{unit ? "Batch size (gummies) *" : "Batch size (Kg) *"}</label>
          <input className={`field !py-1.5 text-xs ${canEdit && !(Number(header.batchSize) > 0) ? "!border-amber-400" : ""}`} type="number" min="0" step="any" value={header.batchSize} disabled={!canEdit} onChange={(e) => { setHeader((h) => ({ ...h, batchSize: e.target.value })); setDirty(true); }} />
        </div>
        {unit && (
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">Average gummy weight (mg)</label>
            <input className="field !py-1.5 text-xs" type="number" min="0" step="any" value={header.avgUnitWeightMg} disabled={!canEdit} onChange={(e) => { setHeader((h) => ({ ...h, avgUnitWeightMg: e.target.value })); setDirty(true); }} />
          </div>
        )}
      </div>

      {canEdit && !recipeId && commonRecipeId && !snapshot && !slot && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
          <span>
            There is no recipe of "{productName}" for {customerLabel} yet. An older <b>common</b> recipe with this name exists. It is not used for any customer unless you choose to.
          </span>
          <button type="button" className="btn-ghost btn-sm shrink-0" disabled={useCommon} onClick={() => setUseCommon(true)}>
            Use the common recipe for {customerLabel}
          </button>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCopying((v) => !v)}>
            <Copy className="h-3 w-3" strokeWidth={2.5} /> Copy recipe from another product
          </button>
          {slot && <SlotExcelLoad mode="rm" productName={productName} onLoaded={loadSheet} />}
        </div>
      )}
      {copying && canEdit && (
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-[1fr_auto]">
          <ItemPicker items={(allRecipes ?? []).filter((r) => r.id !== recipeId).map((r) => ({ id: r.id, name: `${r.name} (${r.customerId ? customerName.get(r.customerId) ?? "customer" : "common"})` }))} value={copyId} onChange={setCopyId} placeholder="- Recipe to copy from -" />
          <button type="button" className="btn-primary btn-sm" disabled={!copyDetail} onClick={loadCopy}>Load</button>
        </div>
      )}

      <div>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-2">Ingredient (Warehouse RM item)</th>
                <th className="px-2 py-2">Make</th>
                <th className="w-14 px-2 py-2">UOM</th>
                <th className="w-28 px-2 py-2 text-right">{unit ? "Qty / gummy" : "Qty / Kg"}</th>
                <th className="w-28 px-2 py-2 text-right">Qty / batch</th>
                {canEdit && <th className="w-8 px-1 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-6 text-center text-slate-400">No recipe yet.</td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.key} className="align-top">
                  <td className="min-w-[15rem] px-2 py-1.5">
                    {canEdit ? (
                      <>
                        <ItemPicker items={itemOptions} value={r.itemId} onChange={(id) => pickItem(r.key, id)} placeholder="- Pick Warehouse item -" />
                        {!r.itemId && (
                          <input className="field mt-1 !py-1 text-xs" placeholder="Ingredient name (not in Warehouse list)" value={r.name} onChange={(e) => setRow(r.key, { name: e.target.value })} />
                        )}
                      </>
                    ) : (
                      <span className="text-slate-700">{r.itemCode ? `${r.itemCode} - ${r.name}` : r.name}</span>
                    )}
                    {!r.itemId && r.name.trim() && (
                      <p className="mt-0.5 flex items-center gap-1 text-micro font-semibold text-amber-600">
                        <AlertTriangle className="h-3 w-3" /> Not in Warehouse list: {r.name}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <input className="field !py-1 text-xs" value={r.brand} disabled={!canEdit} onChange={(e) => setRow(r.key, { brand: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{r.uom}</td>
                  <td className="px-2 py-1.5">
                    <input className="field !py-1 text-right text-xs" type="number" min="0" step="any" value={r.qty} disabled={!canEdit} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-700">{batch > 0 && qtyOf(r) > 0 ? `${fmt(batchOf(r), unit ? 2 : 3)} ${unit ? "g" : "Kg"}` : "-"}</td>
                  {canEdit && (
                    <td className="px-1 py-1.5">
                      <button type="button" className="btn-icon h-6 w-6" title="Remove row" onClick={() => { setRows((prev) => prev.filter((x) => x.key !== r.key)); setDirty(true); }}>
                        <Trash2 className="h-3 w-3" strokeWidth={2.25} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-slate-50 text-xs font-bold text-slate-700">
                <tr>
                  <td colSpan={3} className="px-2 py-2">Total</td>
                  <td className="px-2 py-2 text-right font-mono">{unit ? `${fmt(sumQty, 3)} mg` : `${fmt(sumQty, 4)} Kg`}</td>
                  <td className="px-2 py-2 text-right font-mono">{batch > 0 ? (unit ? `${fmt(sumBatch / 1000, 3)} Kg` : `${fmt(sumBatch, 3)} Kg`) : "-"}</td>
                  {canEdit && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="mt-1 text-micro text-slate-400">
          {unit
            ? `Qty / batch = mg per gummy x ${batch > 0 ? fmt(batch, 0) : "batch"} gummies / 1000 (grams). ${Number(header.avgUnitWeightMg) > 0 ? `All ingredients add up to ${fmt(sumQty, 3)} mg against an average gummy weight of ${fmt(Number(header.avgUnitWeightMg), 3)} mg.` : ""}`
            : <>Qty / batch = Qty per Kg x {batch > 0 ? fmt(batch, 0) : "batch"} Kg. <span className={kgOk ? "text-emerald-600" : "text-amber-600"}>{kgOk ? "Quantities add up to 1.000 Kg." : "Quantities should add up to 1.000 Kg."}</span></>}
          {" "}Plans scale the recipe to the batch size PPIC sets.
        </p>
        {canEdit && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setRows((prev) => [...prev, newRow(kind)]); setDirty(true); }}>
              <Plus className="h-3 w-3" strokeWidth={2.5} /> Add ingredient
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {unlinked > 0 && <span className="text-micro text-amber-600">{unlinked} row(s) not linked to a Warehouse item</span>}
              <input className="field !h-7 !w-48 !py-0 text-xs" placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn-primary btn-sm" disabled={importRecipes.isPending || saveSlot.isPending || !dirty} onClick={handleSave}>
                {importRecipes.isPending || saveSlot.isPending ? "Saving..." : slot ? `Save ${slot}` : "Save recipe"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
