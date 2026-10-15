import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { ApiError, downloadFile } from "../lib/api";
import { useToast } from "./Toast";

// Excel / PDF of one product's BOM (the version on screen), and an Excel of all of a customer's BOMs.
// The Excel is in the same layout as the company's own BOM sheet, so it can be uploaded again.

export function BomDownloadButtons({ kind, id, version, customerName, fileLabel }: { kind: "pm" | "rm"; id: string; version: number | null; customerName?: string; fileLabel: string }) {
  const toast = useToast();
  const qs = new URLSearchParams();
  if (version != null) qs.set("version", String(version));
  if (kind === "rm" && customerName) qs.set("customer", customerName);
  const q = qs.toString() ? `?${qs}` : "";
  async function get(ext: "xlsx" | "pdf") {
    try {
      await downloadFile(`/api/bom-docs/${kind}/${id}/export.${ext}${q}`, `${fileLabel}.${ext}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not download");
    }
  }
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" className="btn-ghost btn-sm" title="Download this BOM as Excel" onClick={() => get("xlsx")}>
        <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Excel
      </button>
      <button type="button" className="btn-ghost btn-sm" title="Download this BOM as PDF" onClick={() => get("pdf")}>
        <FileText className="h-3 w-3" strokeWidth={2.5} /> PDF
      </button>
    </div>
  );
}

export function CustomerBomDownload({ kind, customerId, customerName }: { kind: "pm" | "rm"; customerId: string; customerName: string }) {
  const toast = useToast();
  async function get() {
    try {
      await downloadFile(`/api/bom-docs/customer/${customerId}/export.xlsx?kind=${kind}`, `FLS_${kind.toUpperCase()}_BOM_${customerName.replace(/[^A-Za-z0-9]+/g, "_")}.xlsx`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not download");
    }
  }
  return (
    <button type="button" className="btn-ghost btn-sm mb-2 w-full" title="One Excel file with a sheet for each product of this customer" onClick={get}>
      <Download className="h-3 w-3" strokeWidth={2.5} /> All {kind === "pm" ? "packaging" : "RM"} BOMs (Excel)
    </button>
  );
}
