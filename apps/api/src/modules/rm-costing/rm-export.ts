import ExcelJS from "exceljs";
import type { RmMasterResult } from "./rm-costing-engine";

/**
 * Builds the same multi-sheet workbook the prototype produced client-side
 * with `exportTrueExcel()` — one detailed costing sheet per batch plus a
 * "Master Procurement" rollup — but generated server-side so the export is
 * identical no matter who downloads it, same rationale as
 * packaging-bom/bom-export.ts.
 */
export async function buildRmMasterWorkbook(result: RmMasterResult): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FLS Mitr";
  workbook.created = new Date();

  const colWidths = [10, 35, 15, 10, 8, 12, 10, 15, 8, 15, 12];

  for (const res of result.batches) {
    // Sheet names are capped at 31 chars and can't contain \/?*[] — same
    // sanitization the prototype applied before XLSX.utils.book_append_sheet.
    const safeName = res.recipeName.replace(/[\\/?*[\]]/g, "").substring(0, 31);
    const sheet = workbook.addWorksheet(safeName || `Batch ${result.batches.indexOf(res) + 1}`);
    sheet.columns = colWidths.map((width) => ({ width }));

    sheet.addRow([res.recipeName]).font = { bold: true };
    sheet.addRow(["Gm per Serving", res.gmPerServing, "", "Batch Size in KG", res.batchSizeKg]);
    sheet.addRow(["Serving per Batch", res.servingsPerBatch, "", "Protein % in Batch", res.proteinPctInBatch / 100]);
    sheet.addRow(["Cost per Kg Without Packaging", res.costPerKgWithoutPkg]);
    sheet.addRow([]);

    const headerRow = sheet.addRow([
      "Protein %",
      "Ingredients Name",
      "Brand",
      "Cost",
      "Unit",
      "Rate per gm",
      "g/serving",
      "Per Batch",
      "Unit",
      "Amount",
      "Qty in Kg",
    ]);
    headerRow.font = { bold: true };

    for (const ing of res.ingredients) {
      sheet.addRow([
        ing.proteinPct,
        ing.name,
        ing.brand,
        ing.costPerKg,
        "KG",
        ing.ratePerGm,
        ing.gPerServing,
        ing.perBatchGrams,
        "KG",
        ing.amount,
        ing.qtyInKg,
      ]);
    }
    sheet.addRow([]);

    const waterfallRows: (string | number)[][] = [
      ["", "", "", "", "", "", "", "Total RM Cost", "", res.totalRmCost],
      ["", "", "", "", "", "", "", "Testing Cost Protein", "", res.testCost],
      ["", "", "", "", "", "", "", "For Powder (Kg)", res.batchSizeKg, res.powderCostPlusTesting],
      ["", "", "", "", "", "", "", "Manufacturing Loss", res.mfgLossPct / 100, res.mfgLossAmount],
      ["", "", "", "", "", "", "", "For Powder in g", res.packSizeG, res.costPerPouchPowder],
      ["", "", "", "", "", "", "", "Jar", "", res.jarCost],
      ["", "", "", "", "", "", "", "Scoop + Wad", "", res.scoopCost],
      ["", "", "", "", "", "", "", "Label", "", res.labelCost],
      ["", "", "", "", "", "", "", "Conversion", "", res.convCost],
      ["", "", "", "", "", "", "", "CCB/Copp", "", res.ccbCost],
      ["", "", "", "", "", "", "", "Total Cost Including Packaging", "", res.cogsPerPouch],
      ["", "", "", "", "", "", "", "Profit", res.profitPct / 100, res.profitAmount],
      ["", "", "", "", "", "", "", "GST", res.gstPct / 100, res.gstAmount],
      ["", "", "", "", "", "", "", "Price Per Pouch", "", res.pricePerPouch],
    ];
    for (const row of waterfallRows) sheet.addRow(row);
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
