import { useState } from "react";
import { BadgeCheck, ChevronRight, Hourglass, Search, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAllowOtherVendor,
  useSetMaterialVendors,
  useVendorDeviations,
  useVendorOptions,
  useVendorProduct,
  useVendorProducts,
  useWaitingForVendor,
  useWithdrawDeviation,
  type VendorProductMaterial,
  type VendorRuleKind,
  type WaitingBatch,
} from "../lib/stockControlHooks";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { fmtQty } from "../lib/format";

// Some products may use a material only from specific vendors. R&D (which doubles as QA here) decides which vendors those are, per product
// and per material; Purchase can then only order it from them, and Store / Day Store can only issue and dispense their lots. When the
// approved vendor's stock is not enough, the batch waits here for R&D: wait for that vendor, or allow another one with a reason.
export function ApprovedVendorsPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("RND");
  const [tab, setTab] = useState<"RM" | "PM" | "WAITING">("RM");
  const { data: waiting } = useWaitingForVendor();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-violet-50 text-violet-600">
          <BadgeCheck className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Approved Vendors</h1>
          <p className="text-sm text-slate-500">Products that may take a material only from specific vendors. Everything not listed here is unrestricted.</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ["RM", "Raw material (by recipe)"],
            ["PM", "Packaging (by SKU)"],
            ["WAITING", `Waiting for a decision${waiting?.length ? ` (${waiting.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-bold ${tab === key ? "border-violet-600 text-violet-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "WAITING" ? <WaitingPanel canEdit={canEdit} /> : <RulesPanel key={tab} kind={tab} canEdit={canEdit} />}
    </div>
  );
}

function RulesPanel({ kind, canEdit }: { kind: VendorRuleKind; canEdit: boolean }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data: products, isLoading } = useVendorProducts(kind, search);

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <div className="card overflow-hidden">
        <div className="relative border-b border-slate-100 p-3">
          <Search className="pointer-events-none absolute left-5 top-5 h-4 w-4 text-slate-400" />
          <input className="input w-full pl-8" placeholder={kind === "RM" ? "Search recipe or customer" : "Search SKU or customer"} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {isLoading ? (
          <SkeletonRows rows={5} cols={1} />
        ) : !products?.length ? (
          <p className="p-6 text-center text-sm text-slate-400">{kind === "RM" ? "No recipes found." : "No SKUs found."}</p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto">
            {products.map((p) => (
              <li key={p.id}>
                <button onClick={() => setSelected(p.id)} className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-slate-50 ${selected === p.id ? "bg-violet-50" : ""}`}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-slate-800">{p.name}</span>
                    <span className="block truncate text-micro text-slate-400">{p.customerName ?? "—"} · {p.materialCount} material{p.materialCount === 1 ? "" : "s"}</span>
                  </span>
                  {p.restrictedCount > 0 && <span className="pill shrink-0 border-violet-200 bg-violet-50 text-violet-700">{p.restrictedCount} restricted</span>}
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected ? <ProductPanel key={selected} kind={kind} id={selected} canEdit={canEdit} /> : <EmptyState icon={BadgeCheck} title="Pick a product" hint="Choose a product on the left to see, and set, which vendors each of its materials may come from." accent="violet" />}
    </div>
  );
}

function ProductPanel({ kind, id, canEdit }: { kind: VendorRuleKind; id: string; canEdit: boolean }) {
  const { data: product, isLoading } = useVendorProduct(kind, id);
  const { data: vendors } = useVendorOptions();
  if (isLoading || !product) return <SkeletonRows rows={4} cols={3} />;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-3">
        <h2 className="text-lg font-black text-slate-900">{product.name}</h2>
        <p className="text-xs text-slate-500">{product.customerName ?? ""}</p>
      </div>
      {product.materials.length === 0 ? (
        <p className="p-6 text-sm text-slate-400">{kind === "RM" ? "This recipe has no ingredients." : "This SKU has no packaging components."}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {product.materials.map((m) => (
            <MaterialRow key={m.key} kind={kind} productId={product.id} material={m} vendors={vendors ?? []} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialRow({ kind, productId, material, vendors, canEdit }: { kind: VendorRuleKind; productId: string; material: VendorProductMaterial; vendors: { id: string; name: string }[]; canEdit: boolean }) {
  const toast = useToast();
  const set = useSetMaterialVendors(kind, productId);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function open() {
    setPicked(new Set(material.approved.map((a) => a.vendorId)));
    setEditing(true);
  }

  async function save() {
    try {
      await set.mutateAsync({ name: material.name, itemId: material.itemId ?? undefined, vendorIds: [...picked] });
      toast.success(picked.size ? "Approved vendors saved." : "Restriction removed - any vendor can be used.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save this");
    }
  }

  // A packaging component with no packaging item linked has no stock to restrict.
  const unlinked = kind === "PM" && !material.itemId;

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800">{material.name}</p>
          {material.detail && <p className="text-micro text-slate-400">{material.detail}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {material.approved.length === 0 ? (
            <span className="text-xs text-slate-400">Any vendor</span>
          ) : (
            material.approved.map((a) => (
              <span key={a.vendorId} className="pill border-violet-200 bg-violet-50 text-violet-700">
                {a.name}
              </span>
            ))
          )}
          {canEdit && !editing && !unlinked && (
            <button className="btn-ghost btn-sm" onClick={open}>
              {material.approved.length ? "Change" : "Restrict"}
            </button>
          )}
          {unlinked && <span className="text-micro text-slate-400">No packaging item linked</span>}
        </div>
      </div>
      {editing && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-semibold text-slate-600">Tick the vendors this product may use for {material.name}. Untick all to remove the restriction.</p>
          <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
            {vendors.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={picked.has(v.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(v.id);
                    else next.delete(v.id);
                    setPicked(next);
                  }}
                />
                {v.name}
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn-primary btn-sm" disabled={set.isPending} onClick={save}>
              {set.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function WaitingPanel({ canEdit }: { canEdit: boolean }) {
  const { data: waiting, isLoading } = useWaitingForVendor();
  const { data: deviations } = useVendorDeviations();
  const withdraw = useWithdrawDeviation();
  const toast = useToast();

  return (
    <div className="space-y-6">
      {isLoading ? (
        <SkeletonRows rows={3} cols={6} />
      ) : !waiting?.length ? (
        <EmptyState icon={Hourglass} title="No batch is waiting on an approved vendor" hint="A batch shows up here when its approved vendor's stock is not enough to dispense it." accent="violet" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full whitespace-nowrap">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>PO / Product</th>
                  <th>Material</th>
                  <th className="text-right">Needed</th>
                  <th className="text-right">Approved vendor stock</th>
                  <th className="text-right">Other vendors' stock</th>
                  <th>Approved vendors</th>
                  <th className="text-right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((w) => (
                  <WaitingRow key={`${w.batchId}-${w.itemId}`} row={w} canEdit={canEdit} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!!deviations?.length && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Other vendors R&D has allowed</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {deviations.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-bold text-slate-800">
                    {d.productName} · {d.material}
                  </p>
                  <p className="text-xs text-slate-500">
                    {d.poNumber ? `PO ${d.poNumber} · ` : ""}
                    {d.customerName} · was restricted to {d.approvedVendors.join(" / ")}
                  </p>
                  <p className="text-xs text-slate-500">
                    “{d.reason}” - {d.approvedByName}, {new Date(d.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </p>
                </div>
                {canEdit && (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={withdraw.isPending}
                    onClick={() => withdraw.mutate(d.id, { onSuccess: () => toast.success("Restriction is back on for this product."), onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not do this") })}
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Restrict again
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WaitingRow({ row, canEdit }: { row: WaitingBatch; canEdit: boolean }) {
  const toast = useToast();
  const allow = useAllowOtherVendor();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function submit() {
    try {
      await allow.mutateAsync({ purchaseOrderItemId: row.purchaseOrderItemId, itemId: row.itemId, reason: reason.trim() });
      toast.success("Another vendor is allowed for this product.");
      setOpen(false);
      setReason("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not do this");
    }
  }

  return (
    <>
      <tr>
        <td className="font-bold text-slate-800">{row.batchNo ?? "—"}</td>
        <td className="text-slate-600">
          {row.poNumber ?? "—"}
          <span className="block text-micro text-slate-400">{row.productName}</span>
        </td>
        <td className="font-semibold text-slate-700">{row.material}</td>
        <td className="text-right font-mono">
          {fmtQty(row.neededQty)} {row.unit}
        </td>
        <td className="text-right font-mono font-bold text-rose-700">{fmtQty(row.approvedQty)}</td>
        <td className="text-right font-mono text-slate-500">{fmtQty(row.otherVendorsQty)}</td>
        <td className="text-violet-700">{row.approvedVendors.join(" / ")}</td>
        <td className="text-right">
          {canEdit ? (
            <button className="btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
              Allow other vendor
            </button>
          ) : (
            <span className="text-xs text-slate-400">R&D decides</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-slate-50/60">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[18rem] flex-1 text-xs font-semibold text-slate-600">
                Why is another vendor fine for {row.productName}? (stays on record)
                <input className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Approved vendor out of stock, QA checked the other lot" />
              </label>
              <button className="btn-primary btn-sm" disabled={allow.isPending || reason.trim().length < 5} onClick={submit}>
                {allow.isPending ? "Saving…" : "Allow"}
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
            <p className="mt-2 text-micro text-slate-400">This lifts the restriction for this material on this product order only, so its other batches can use any vendor too.</p>
          </td>
        </tr>
      )}
    </>
  );
}
