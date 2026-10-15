import { useRef, useState, type ChangeEvent } from "react";
import { Building2, Download, Pencil, Upload, UserPlus, Users as UsersIcon } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreateCustomer, useImportCustomerUpdates, useUpdateCustomer } from "../lib/hooks";
import { usePagedList } from "../lib/usePagedList";
import { Pagination } from "../components/Pagination";
import { downloadCustomerUpdateImportTemplate, parseCustomerUpdateWorkbook } from "../lib/customersImport";
import { FieldGrid, type FieldDef } from "../components/FieldGrid";
import { SearchBar } from "../components/SearchBar";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { Customer } from "../lib/types";
import { CUSTOMER_TYPES, useSetTop10 } from "../lib/customerTags";
import { CustomerTagPills } from "../components/CustomerName";

// The customer directory, in full — every field the backend has always
// supported (contactPerson, contactNo, gstNo, email, deliveryAddress) but
// the PO form's own quick "+ New" only ever asked for a Company Name. That
// quick-add still exists (fast path while raising a PO), this page is the
// place to fill in the rest, or add a customer with everything up front.
const FIELDS: FieldDef[] = [
  { name: "companyName", label: "Company Name *", type: "text" },
  { name: "contactPerson", label: "Contact Person", type: "text" },
  { name: "contactNo", label: "Contact No.", type: "tel" },
  { name: "gstNo", label: "GST No.", type: "text" },
  { name: "email", label: "Email", type: "email" },
  { name: "deliveryAddress", label: "Delivery Address", type: "text" },
];

// Matches the server's own createCustomerSchema regex — checked here too
// so a bad value is caught before the round-trip, not just after.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toDraft(c: Customer): Record<string, string> {
  return {
    companyName: c.companyName,
    contactPerson: c.contactPerson ?? "",
    contactNo: c.contactNo ?? "",
    gstNo: c.gstNo ?? "",
    email: c.email ?? "",
    deliveryAddress: c.deliveryAddress ?? "",
  };
}

export function CustomersPage() {
  const { hasRole } = useAuth();
  // Matches the backend exactly — customer writes are BD-only (ADMIN
  // bypasses server-side regardless); the directory read itself is open
  // to everyone, same as the PO form's own customer picker.
  const canWrite = hasRole("BD");
  // Server-side paginated + searched; the whole directory is never loaded here.
  const [types, setTypes] = useState<string[]>([]);
  const paged = usePagedList<Customer>({ key: ["customers", "list"], path: "/api/customers", params: { type: types.length ? types : undefined } });
  const setTop10 = useSetTop10();
  const isLoading = paged.isLoading;
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();
  const importUpdates = useImportCustomerUpdates();
  const toast = useToast();
  const importFileRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<"none" | "create" | string>("none"); // any other string = editing that customer's id
  const [draft, setDraft] = useState<Record<string, string>>({});

  const filtered = paged.rows;
  const isNewCustomer = (c: Customer) => !!c.isNew;

  function startCreate() {
    setDraft({});
    setMode("create");
  }
  function startEdit(c: Customer) {
    setDraft(toDraft(c));
    setMode(c.id);
  }
  function cancel() {
    setMode("none");
    setDraft({});
  }

  // Bulk update — one row per existing customer, matched by Company Name;
  // never creates. Same parse-then-toast-summary shape every other bulk
  // import in this app uses (see PurchaseOrdersPage.tsx).
  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseCustomerUpdateWorkbook(buffer);
      if (!rows.length) {
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a Company Name to match against.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}).`,
        );
      }

      const summary = await importUpdates.mutateAsync(rows);
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — no Company Name)` : "";
      const problems = summary.results.filter((r) => r.status !== "updated");
      const problemNote = problems.length
        ? ` — ${problems
            .slice(0, 5)
            .map((r) => `row ${r.row} (${r.companyName}): ${r.message}`)
            .join("; ")}${problems.length > 5 ? `; …and ${problems.length - 5} more` : ""}`
        : "";
      if (summary.updated > 0) {
        toast.success(`Updated ${summary.updated} of ${summary.rowsProcessed} customer(s).${skippedNote}${problemNote}`);
      } else {
        toast.error(`Updated 0 of ${summary.rowsProcessed} customer(s).${skippedNote}${problemNote}`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import failed — check the file and try again.");
    }
  }

  async function save() {
    if (!draft.companyName?.trim()) {
      toast.error("Company Name is required.");
      return;
    }
    // The "tel" field already strips non-digits and caps at 10 as you
    // type (see FieldGrid), but a pasted/pre-filled value could still
    // slip through short — worth catching before the round-trip.
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
      companyName: draft.companyName.trim(),
      contactPerson: draft.contactPerson?.trim() || undefined,
      contactNo: draft.contactNo?.trim() || undefined,
      gstNo: draft.gstNo?.trim() || undefined,
      email: draft.email?.trim() || undefined,
      deliveryAddress: draft.deliveryAddress?.trim() || undefined,
    };
    try {
      if (mode === "create") {
        await createCustomer.mutateAsync(body);
        toast.success(`Created "${body.companyName}".`);
      } else {
        await updateCustomer.mutateAsync({ id: mode, body });
        toast.success(`Updated "${body.companyName}".`);
      }
      cancel();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save customer");
    }
  }

  const saving = createCustomer.isPending || updateCustomer.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <Building2 className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Customers</h1>
          <p className="text-sm text-slate-500">The full customer directory — contact details, GST, delivery address.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-72">
          <SearchBar value={paged.search} onChange={paged.setSearch} placeholder="Search by company, contact, GST…" />
        </div>
        {canWrite && (
          <button className="btn-ghost" onClick={downloadCustomerUpdateImportTemplate} title="Download a blank template — fill in the Company Name of an existing customer per row plus whichever fields you want changed">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
          </button>
        )}
        {canWrite && (
          <button className="btn-ghost" disabled={importUpdates.isPending} onClick={() => importFileRef.current?.click()} title="Upload a sheet — updates matching existing customers directly, doesn't create new ones">
            <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importUpdates.isPending ? "Importing…" : "Import Excel"}
          </button>
        )}
        <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
        {canWrite && mode === "none" && (
          <button className="btn-primary" onClick={startCreate}>
            <UserPlus className="h-4 w-4" strokeWidth={2.5} /> New Customer
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-micro font-bold uppercase tracking-wide text-slate-400">Customer type</span>
        {CUSTOMER_TYPES.map((t) => {
          const on = types.includes(t);
          return (
            <button key={t} type="button" onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])} className={`rounded-full border px-3 py-1 text-xs font-bold transition ${on ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {t}
            </button>
          );
        })}
        {types.length > 0 && (
          <button type="button" className="text-xs font-bold text-slate-400 hover:text-rose-600" onClick={() => setTypes([])}>
            Clear
          </button>
        )}
      </div>

      {mode !== "none" && (
        <div className="card p-5">
          <p className="label mb-3">{mode === "create" ? "New Customer" : "Edit Customer"}</p>
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
      ) : !filtered.length ? (
        <EmptyState
          icon={UsersIcon}
          title={paged.isFiltered ? "No matching customers" : "No customers yet"}
          hint={paged.isFiltered ? "Try a different search." : "Add your first customer to start creating Purchase Orders."}
          accent="brand"
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Type</th>
                  <th>Contact Person</th>
                  <th>Contact No.</th>
                  <th>GST No.</th>
                  <th>Email</th>
                  {canWrite && <th className="text-right">Edit</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td className="font-bold text-slate-800">{c.companyName}</td>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <CustomerTagPills isNew={isNewCustomer(c)} isTop10={c.isTop10} />
                        {!isNewCustomer(c) && !c.isTop10 && <span className="text-slate-400">Others</span>}
                        {canWrite && (
                          <button
                            type="button"
                            disabled={setTop10.isPending}
                            title={c.isTop10 ? "Remove from the Top 10" : "Add to the Top 10"}
                            onClick={() => setTop10.mutate({ id: c.id, isTop10: !c.isTop10 }, { onSuccess: () => toast.success(c.isTop10 ? `${c.companyName} removed from the Top 10.` : `${c.companyName} added to the Top 10.`), onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save") })}
                            className={`ml-1 rounded-full border px-2 py-0.5 text-micro font-bold transition ${c.isTop10 ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                          >
                            {c.isTop10 ? "Top 10 ✓" : "Make Top 10"}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="text-slate-600">{c.contactPerson ?? "—"}</td>
                    <td className="text-slate-600">{c.contactNo ?? "—"}</td>
                    <td className="text-slate-600">{c.gstNo ?? "—"}</td>
                    <td className="text-slate-600">{c.email ?? "—"}</td>
                    {canWrite && (
                      <td className="text-right">
                        <button className="btn-icon" onClick={() => startEdit(c)} title="Edit">
                          <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </div>
  );
}
