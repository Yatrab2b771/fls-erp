import { useRef, useState, type ChangeEvent } from "react";
import { Download, Pencil, Truck, Upload, UserPlus } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreateVendor, useImportVendors, useUpdateVendor, useVendors } from "../lib/hooks";
import { downloadVendorImportTemplate, parseVendorWorkbook } from "../lib/vendorsImport";
import { FieldGrid, type FieldDef } from "../components/FieldGrid";
import { SearchBar } from "../components/SearchBar";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { Vendor } from "../lib/types";

// The vendor directory — RM/PM suppliers Purchase deals with, not to be
// confused with the Customers page (the brand placing a sales order).
const FIELDS: FieldDef[] = [
  { name: "name", label: "Vendor Name *", type: "text" },
  { name: "code", label: "Vendor Code", type: "text" },
  { name: "contactPerson", label: "Contact Person", type: "text" },
  { name: "contactNo", label: "Contact No.", type: "tel" },
  { name: "gstNo", label: "GST No.", type: "text" },
  { name: "email", label: "Email", type: "email" },
  { name: "address", label: "Address", type: "text" },
];

// Matches the server's own createVendorSchema regex — checked here too
// so a bad value is caught before the round-trip, not just after.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toDraft(v: Vendor): Record<string, string> {
  return {
    name: v.name,
    code: v.code ?? "",
    contactPerson: v.contactPerson ?? "",
    contactNo: v.contactNo ?? "",
    gstNo: v.gstNo ?? "",
    email: v.email ?? "",
    address: v.address ?? "",
  };
}

export function VendorsPage() {
  const { hasRole } = useAuth();
  // Matches the backend exactly — vendor writes are Purchase-only (ADMIN
  // bypasses server-side regardless); the directory read itself is
  // broad, same list Pre-Inventory's GET already uses.
  const canWrite = hasRole("PURCHASE");
  const { data: vendors, isLoading } = useVendors();
  const createVendor = useCreateVendor();
  const updateVendor = useUpdateVendor();
  const importVendors = useImportVendors();
  const toast = useToast();
  const importFileRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"none" | "create" | string>("none"); // any other string = editing that vendor's id
  const [draft, setDraft] = useState<Record<string, string>>({});

  const q = search.trim().toLowerCase();
  const filtered = vendors?.filter(
    (v) => !q || v.name.toLowerCase().includes(q) || (v.code ?? "").toLowerCase().includes(q) || (v.contactPerson ?? "").toLowerCase().includes(q) || (v.gstNo ?? "").toLowerCase().includes(q),
  );

  function startCreate() {
    setDraft({});
    setMode("create");
  }
  function startEdit(v: Vendor) {
    setDraft(toDraft(v));
    setMode(v.id);
  }
  function cancel() {
    setMode("none");
    setDraft({});
  }

  // Create-or-update by Name — unlike Customers' import (update-only),
  // a vendor list sheet is treated as the source of truth: a name seen
  // for the first time creates a vendor, a name seen again updates it.
  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseVendorWorkbook(buffer);
      if (!rows.length) {
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a Vendor Name.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}).`,
        );
      }

      const summary = await importVendors.mutateAsync(rows);
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — no Vendor Name)` : "";
      const problems = summary.results.filter((r) => r.status === "invalid");
      const problemNote = problems.length
        ? ` — ${problems
            .slice(0, 5)
            .map((r) => `row ${r.row} (${r.name}): ${r.message}`)
            .join("; ")}${problems.length > 5 ? `; …and ${problems.length - 5} more` : ""}`
        : "";
      toast.success(`${summary.created} created, ${summary.updated} updated of ${summary.rowsProcessed} vendor(s).${skippedNote}${problemNote}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import failed — check the file and try again.");
    }
  }

  async function save() {
    if (!draft.name?.trim()) {
      toast.error("Vendor Name is required.");
      return;
    }
    const contactNo = draft.contactNo?.trim();
    if (contactNo && !/^\d{10}$/.test(contactNo)) {
      toast.error("Contact No. must be exactly 10 digits.");
      return;
    }
    const email = draft.email?.trim();
    if (email && !EMAIL_PATTERN.test(email)) {
      toast.error("Enter a valid email address.");
      return;
    }
    const body = {
      name: draft.name.trim(),
      code: draft.code?.trim() || undefined,
      contactPerson: draft.contactPerson?.trim() || undefined,
      contactNo: draft.contactNo?.trim() || undefined,
      gstNo: draft.gstNo?.trim() || undefined,
      email: draft.email?.trim() || undefined,
      address: draft.address?.trim() || undefined,
    };
    try {
      if (mode === "create") {
        await createVendor.mutateAsync(body);
        toast.success(`Created "${body.name}".`);
      } else {
        await updateVendor.mutateAsync({ id: mode, body });
        toast.success(`Updated "${body.name}".`);
      }
      cancel();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save vendor");
    }
  }

  const saving = createVendor.isPending || updateVendor.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <Truck className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Vendors</h1>
          <p className="text-sm text-slate-500">The RM/PM supplier directory — contact details, GST, address.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-72">
          <SearchBar value={search} onChange={setSearch} placeholder="Search by name, code, contact, GST…" />
        </div>
        {canWrite && (
          <button className="btn-ghost" onClick={downloadVendorImportTemplate} title="Download a blank template — one row per vendor">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
          </button>
        )}
        {canWrite && (
          <button
            className="btn-ghost"
            disabled={importVendors.isPending}
            onClick={() => importFileRef.current?.click()}
            title="Upload a sheet — creates a new vendor per name, updates one already on file"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importVendors.isPending ? "Importing…" : "Import Excel"}
          </button>
        )}
        <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
        {canWrite && mode === "none" && (
          <button className="btn-primary" onClick={startCreate}>
            <UserPlus className="h-4 w-4" strokeWidth={2.5} /> New Vendor
          </button>
        )}
      </div>

      {mode !== "none" && (
        <div className="card p-5">
          <p className="label mb-3">{mode === "create" ? "New Vendor" : "Edit Vendor"}</p>
          <FieldGrid fields={FIELDS} values={draft} onChange={(name, value) => setDraft((d) => ({ ...d, [name]: value }))} />
          <div className="mt-4 flex gap-2">
            <button className="btn-primary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn-ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <SkeletonRows rows={5} cols={5} />
      ) : !filtered?.length ? (
        <EmptyState icon={Truck} title="No vendors yet" hint="Add your first vendor, or import a list from Excel." accent="brand" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Contact Person</th>
                  <th>Contact No.</th>
                  <th>GST No.</th>
                  <th>Email</th>
                  {canWrite && <th className="text-right">Edit</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((v) => (
                  <tr key={v.id}>
                    <td className="font-bold text-slate-800">{v.name}</td>
                    <td className="text-slate-600">{v.code ?? "—"}</td>
                    <td className="text-slate-600">{v.contactPerson ?? "—"}</td>
                    <td className="text-slate-600">{v.contactNo ?? "—"}</td>
                    <td className="text-slate-600">{v.gstNo ?? "—"}</td>
                    <td className="text-slate-600">{v.email ?? "—"}</td>
                    {canWrite && (
                      <td className="text-right">
                        <button className="btn-icon" onClick={() => startEdit(v)} title="Edit">
                          <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </button>
                      </td>
                    )}
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
