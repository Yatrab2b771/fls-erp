import { useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { BOM_SHEET_LABEL, downloadBomSample, normName, parseBomWorkbook, type ParsedBomWorkbook, type ParsedPmProduct, type ParsedRmRecipe } from "../lib/bomTemplateImport";
import { useCreateCustomer, useCreateSku, useCustomers, useImportRecipes, useInventoryItems, useRecipes, useSkus, useUpdateSkuPackagingComponents } from "../lib/hooks";
import { useToast } from "./Toast";

// Upload one of the company's own BOM Excel sheets. The page reads it, says what it found and asks which
// customer it is for (the sheets carry no customer), and saves only after the user confirms. Every save is a
// new version of that product's BOM, so an older BOM is never overwritten for good.

type Mode = "PM" | "RM";

export function BomUploadBox({ mode, onSaved }: { mode: Mode; onSaved?: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const createSku = useCreateSku();
  const importRecipes = useImportRecipes();
  const { data: storeItems } = useInventoryItems(mode);
  const { data: recipes } = useRecipes({ enabled: mode === "RM" });

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedBomWorkbook | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  // Batch size per sheet (packs for packaging, Kg or gummies for RM). Required, so a sheet without one asks for it here.
  const [batches, setBatches] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const { data: customerSkus } = useSkus(mode === "PM" ? customerId || undefined : undefined);
  const updatePackaging = useUpdateSkuPackagingComponents(customerId || undefined);

  const products: (ParsedPmProduct | ParsedRmRecipe)[] = useMemo(() => (parsed ? (mode === "PM" ? parsed.pm : parsed.rm) : []), [parsed, mode]);
  const otherKindCount = parsed ? (mode === "PM" ? parsed.rm.length : parsed.pm.length) : 0;

  const byCode = useMemo(() => new Map((storeItems ?? []).filter((i) => i.code).map((i) => [i.code!.trim().toLowerCase(), i])), [storeItems]);
  const byName = useMemo(() => new Map((storeItems ?? []).map((i) => [normName(i.name), i])), [storeItems]);
  function match(code: string, name: string) {
    return (code && byCode.get(code.trim().toLowerCase())) || byName.get(normName(name)) || null;
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage("");
    try {
      const result = parseBomWorkbook(await file.arrayBuffer());
      setParsed(result);
      setFileName(file.name);
      const n: Record<string, string> = {};
      const b: Record<string, string> = {};
      for (const p of result.pm) { n[p.sheet] = p.productName; b[p.sheet] = p.batchPacks ? String(p.batchPacks) : ""; }
      for (const p of result.rm) { n[p.sheet] = p.productName; b[p.sheet] = p.batchSize ? String(p.batchSize) : ""; }
      setNames(n);
      setBatches(b);
      setSkipped({});
      const found = mode === "PM" ? result.pm.length : result.rm.length;
      if (!found) setMessage(mode === "PM" ? "No packaging BOM sheet found in this file." : "No RM BOM sheet found in this file.");
    } catch {
      setParsed(null);
      setMessage("Could not read this file. Please upload the .xlsx BOM sheet.");
    }
  }

  function reset() {
    setParsed(null);
    setFileName("");
    setCustomerId("");
    setNewCustomer("");
    setMessage("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function ensureCustomer(): Promise<string | null> {
    if (customerId) return customerId;
    const name = newCustomer.trim();
    if (!name) return null;
    const created = await createCustomer.mutateAsync({ companyName: name });
    setCustomerId(created.id);
    return created.id;
  }

  async function confirm() {
    setBusy(true);
    try {
      const cid = await ensureCustomer();
      if (!cid) {
        toast.error("Choose the customer this file is for (or type a new one).");
        return;
      }
      const note = `Uploaded from ${fileName}`;
      let saved = 0;
      let unlinked = 0;
      for (const p of products) {
        if (skipped[p.sheet]) continue;
        const productName = (names[p.sheet] ?? p.productName).trim();
        if (!productName) continue;
        const batch = Number(batches[p.sheet]);
        if (!(batch > 0)) {
          toast.error(`Batch size is required for "${productName}".`);
          return;
        }
        if (mode === "PM") {
          const pm = p as ParsedPmProduct;
          const existing = (customerSkus ?? []).find((s) => s.productName.toLowerCase() === productName.toLowerCase());
          const sku = existing ?? (await createSku.mutateAsync({ customerId: cid, productName }));
          const used = new Map<string, number>();
          const components = pm.rows.map((r) => {
            const item = match(r.code, r.name);
            if (!item) unlinked += 1;
            // Each component type is unique per product, so two rows with the same name are told apart.
            const base = r.name;
            const count = (used.get(base.toLowerCase()) ?? 0) + 1;
            used.set(base.toLowerCase(), count);
            return {
              type: count > 1 ? `${base} (${count})` : base,
              quantity: r.qty,
              unit: r.uom || "Nos",
              pmCode: (item?.code ?? r.code) || undefined,
              pmItemId: item?.id ?? null,
              // "Nil" on the sheet means no overage at all, not the default.
              overagePct: r.overage ?? 0,
              spec: r.spec || null,
              make: r.make || null,
              packingLevel: r.level || null,
            };
          });
          await updatePackaging.mutateAsync({
            id: sku.id,
            note,
            header: { productCode: pm.productCode || null, packSize: pm.packSize || null, packingConfig: pm.packingConfig || null, batchPacks: Math.round(batch) },
            components,
          });
        } else {
          const rm = p as ParsedRmRecipe;
          // The same product listed under this customer, so it shows up in both BOM pages.
          await createSku.mutateAsync({ customerId: cid, productName }).catch(() => undefined);
          const existingRecipe = (recipes ?? []).find((r) => r.customerId === cid && r.name.toLowerCase() === productName.toLowerCase());
          rm.rows.forEach((r) => { if (!match(r.code, r.name)) unlinked += 1; });
          await importRecipes.mutateAsync([
            {
              name: existingRecipe?.name ?? productName,
              customerId: cid,
              kind: rm.kind === "RM_UNIT" ? "PER_UNIT" : "PER_KG",
              productCode: rm.productCode || null,
              versionLabel: rm.versionLabel || null,
              batchSize: batch,
              avgUnitWeightMg: rm.avgUnitWeightMg,
              note,
              ingredients: rm.rows.map((r) => {
                const item = match(r.code, r.name);
                return { name: item?.name ?? r.name, brand: r.make || "Approved Vendor", itemCode: (item?.code ?? r.code) || undefined, gPerServing: r.qty, proteinPct: 0, uom: r.uom };
              }),
            },
          ]);
        }
        saved += 1;
      }
      toast.success(`${saved} BOM(s) saved as a new version.${unlinked ? ` ${unlinked} row(s) are not in the Store list yet - link them on the page.` : ""}`);
      reset();
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save this file");
    } finally {
      setBusy(false);
    }
  }

  const missingBatch = products.some((p) => !skipped[p.sheet] && !(Number(batches[p.sheet]) > 0));
  const label = mode === "PM" ? "Packaging BOM" : "RM BOM";
  return (
    <div className="card mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="label !mb-0 flex items-center gap-1.5">
            <FileSpreadsheet className="h-3.5 w-3.5" /> Upload your {label} Excel
          </p>
          <p className="text-tiny text-slate-400">
            {mode === "PM"
              ? "Use the PM BOM sheet (one sheet per pack size) or the gummies Packing BOM. The page reads the product, pack details and every row, and saves after you confirm."
              : "Use the RM BOM sheet (per Kg, for powder and bar) or the gummies RM BOM (milligrams per gummy). The page reads the product, batch size and every ingredient, and saves after you confirm."}
          </p>
        </div>
        <label className="btn-ghost btn-sm cursor-pointer">
          <Upload className="h-3 w-3" strokeWidth={2.5} /> Choose Excel file
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-tiny text-slate-400">Sample format:</span>
        {(mode === "PM" ? (["PM_PACK", "PM_LEVEL"] as const) : (["RM_KG", "RM_UNIT"] as const)).map((k) => (
          <button key={k} type="button" className="btn-ghost btn-sm" onClick={() => downloadBomSample(k)}>
            <Download className="h-3 w-3" strokeWidth={2.5} /> {BOM_SHEET_LABEL[k]}
          </button>
        ))}
      </div>
      {message && <p className="mt-2 text-xs text-amber-700">{message}</p>}

      {parsed && products.length > 0 && (
        <div className="mt-3 space-y-3 rounded-xl border border-dashed border-violet-300 bg-violet-50/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-700">{fileName}</p>
            <button type="button" className="btn-icon h-6 w-6" title="Cancel" onClick={reset}>
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </div>
          {otherKindCount > 0 && (
            <p className="text-tiny text-amber-700">
              This file also has {otherKindCount} {mode === "PM" ? "RM" : "packaging"} sheet(s); those are ignored here. Upload them on the {mode === "PM" ? "RM BOM" : "Packaging BOM"} page.
            </p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">The sheet has no customer. Which customer is it for?</label>
              <select className="field !py-1.5 text-xs" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">- Choose customer -</option>
                {[...(customers ?? [])].sort((a, b) => a.companyName.localeCompare(b.companyName)).map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName}</option>
                ))}
              </select>
            </div>
            {!customerId && (
              <div>
                <label className="mb-0.5 block text-micro text-slate-400">Or type a new customer</label>
                <input className="field !py-1.5 text-xs" placeholder="New customer name" value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} />
              </div>
            )}
          </div>
          <div className="space-y-2">
            {products.map((p) => {
              const productName = names[p.sheet] ?? p.productName;
              const unlinked = p.rows.filter((r) => !match(r.code, r.name)).length;
              const exists = mode === "PM" ? (customerSkus ?? []).some((s) => s.productName.toLowerCase() === productName.trim().toLowerCase()) : (recipes ?? []).some((r) => r.customerId === customerId && r.name.toLowerCase() === productName.trim().toLowerCase());
              return (
                <div key={p.sheet} className={`rounded-lg border bg-white p-2.5 ${skipped[p.sheet] ? "opacity-50" : "border-slate-200"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-micro font-bold text-slate-500">{BOM_SHEET_LABEL[p.kind]}</span>
                    <input className="field !py-1 min-w-0 flex-1 text-xs font-bold" value={productName} onChange={(e) => setNames((n) => ({ ...n, [p.sheet]: e.target.value }))} />
                    <label className="flex items-center gap-1 text-tiny font-semibold text-slate-600">
                      Batch ({mode === "PM" ? "packs" : p.kind === "RM_UNIT" ? "gummies" : "Kg"}) *
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className={`field !h-7 !w-24 !py-0 text-xs ${Number(batches[p.sheet]) > 0 ? "" : "!border-amber-400"}`}
                        value={batches[p.sheet] ?? ""}
                        onChange={(e) => setBatches((b) => ({ ...b, [p.sheet]: e.target.value }))}
                      />
                    </label>
                    <label className="flex items-center gap-1 text-tiny text-slate-500">
                      <input type="checkbox" checked={!!skipped[p.sheet]} onChange={(e) => setSkipped((s) => ({ ...s, [p.sheet]: e.target.checked }))} /> Skip
                    </label>
                  </div>
                  <p className="mt-1 text-tiny text-slate-500">
                    {p.rows.length} rows
                    {unlinked > 0 ? `, ${unlinked} not in the Store list` : ", all linked to Store items"}
                    {"packSize" in p && p.packSize ? ` - pack ${p.packSize}` : ""}
                    {"packingConfig" in p && p.packingConfig ? ` (${p.packingConfig})` : ""}
                    {"batchSize" in p && p.batchSize ? ` - batch ${p.batchSize} ${p.kind === "RM_UNIT" ? "gummies" : "Kg"}` : ""}
                    {"batchPacks" in p && p.batchPacks ? ` - batch ${p.batchPacks} packs` : ""}
                  </p>
                  {exists && <p className="text-tiny font-semibold text-violet-700">Already has a BOM - this will be saved as a new version; the old one stays.</p>}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={reset}>Cancel</button>
            <button type="button" className="btn-primary btn-sm" disabled={busy || missingBatch || (!customerId && !newCustomer.trim())} onClick={confirm}>
              {busy ? "Saving..." : "Confirm and save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
