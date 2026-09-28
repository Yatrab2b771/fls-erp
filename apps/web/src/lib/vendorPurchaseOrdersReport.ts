import * as XLSX from "xlsx";
import type { VendorPurchaseOrder } from "./types";

// One row per (PO, line item) pair — same shape a real vendor billing
// register would want, not one row per PO. Whatever's currently on
// screen (respects VendorPurchaseOrdersPage's own search filter).
export function exportVendorPurchaseOrdersReport(orders: VendorPurchaseOrder[]) {
  const rows = orders.flatMap((po) =>
    po.items.map((item) => ({
      "PO Number": po.poNumber,
      Vendor: po.vendor.name,
      "Order Date": po.orderDate?.slice(0, 10) ?? "",
      ETA: po.eta?.slice(0, 10) ?? "",
      Status: po.status,
      Item: item.item.name,
      Category: item.item.category,
      Quantity: item.quantity,
      Unit: item.unit,
      Rate: item.rate,
      "GST %": item.gstPct,
      "Line Amount": item.amount,
      "Received Qty": item.receivedQty,
      "Freight Charges": po.freightCharges ?? "",
      "PO Total": po.totalAmount,
    })),
  );
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Vendor POs");
  XLSX.writeFile(workbook, `FLS_Vendor_POs_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
