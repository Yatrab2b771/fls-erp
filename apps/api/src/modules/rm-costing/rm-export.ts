import ExcelJS from "exceljs";
import type { RmMasterResult } from "./rm-costing-engine";

/**
 * Builds the same multi-sheet workbook the prototype produced client-side
 * with `exportTrueExcel()` — one detailed sheet per batch plus a
 * "Master Procurement" rollup — but generated server-side so the export is
 * identical no matter who downloads it, same rationale as
 * packaging-bom/bom-export.ts.
 */
export async function buildRmMasterWorkbook(result: RmMasterResult): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FLS Mitr";
  workbook.created = new Date();

  const colWidths = [10, 35, 15, 10, 12, 15, 8, 12];

  for (const res of result.batches) {
    // Sheet names are capped at 31 chars and can't contain \/?*[] — same
    // sanitization the prototype applied before XLSX.utils.book_append_sheet.
    const safeName = res.recipeName.replace(/[\\/?*[\]]/g, "").substring(0, 31);
    const sheet = workbook.addWorksheet(safeName || `Batch ${result.batches.indexOf(res) + 1}`);
    sheet.columns = colWidths.map((width) => ({ width }));

    sheet.addRow([res.recipeName]).font = { bold: true };
    sheet.addRow(["Gm per Serving", res.gmPerServing, "", "Batch Size in KG", res.batchSizeKg]);
    sheet.addRow(["Serving per Batch", res.servingsPerBatch, "", "Protein % in Batch", res.proteinPctInBatch / 100]);
    sheet.addRow([]);

    const headerRow = sheet.addRow(["Protein %", "Ingredients Name", "Brand", "Item Code", "g/serving", "Per Batch", "Unit", "Qty in Kg"]);
    headerRow.font = { bold: true };

    for (const ing of res.ingredients) {
      sheet.addRow([ing.proteinPct, ing.name, ing.brand, ing.itemCode ?? "", ing.gPerServing, ing.perBatchGrams, "g", ing.qtyInKg]);
    }
  }

  const master = workbook.addWorksheet("Master Procurement");
  master.columns = [
    { header: "S.No", key: "sno", width: 8 },
    { header: "Ingredient Descriptor", key: "name", width: 40 },
    { header: "Brand / Make", key: "brand", width: 25 },
    { header: "Total Requirement (KG)", key: "totalKg", width: 25 },
    { header: "Allocation Sources", key: "sources", width: 60 },
  ];
  master.getRow(1).font = { bold: true };

  result.procurement.forEach((line, idx) => {
    master.addRow({
      sno: idx + 1,
      name: line.name,
      brand: line.brand,
      totalKg: Number(line.totalKg.toFixed(3)),
      sources: Object.entries(line.sources)
        .map(([source, qty]) => `${source}: ${qty.toFixed(3)} KG`)
        .join(" | "),
    });
  });
  master.getColumn("totalKg").numFmt = "#,##0.000";

  return workbook.xlsx.writeBuffer();
}
