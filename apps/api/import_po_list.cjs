// Imports FLS PO LIST.xlsx (fls stock folder) into real PurchaseOrder +
// PurchaseOrderItem rows, all attributed to the generic bd@fls.local
// account. Every PO lands as DRAFT — BD still reviews/approves each one
// by hand, same as any other entry into this system.
//
// Run from apps/api: node import_po_list.cjs
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SOURCE_FILE =
  "C:/Users/DELL/OneDrive - TechiesGuru/Workplace/Vaibhav/FLS/Workplace/New folder/fls stock/FLS PO LIST.xlsx";

// Confirmed spelling-variant matches against the existing 78-customer
// catalog (Packaging Material import) — everything else not in this map
// either matches an existing customer exactly (case-insensitive) or gets
// created fresh. Modiway is deliberately NOT mapped to Modicare — kept
// as its own distinct customer per instruction.
const CUSTOMER_ALIAS = {
  "all max": "allmax",
  "anveshan farm": "anveshan",
  "darjuv 9": "darjuv 9 pro",
  fitpage: "fit page(saransh ventures)",
  fulled: "fuelled",
  "leap nutrition": "leap(trimobility pvt)",
  newherb: "neu herbs",
  thycura: "thycure pharma",
  trunativ: "trunative",
};

function cellToString(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  return String(v).trim() || undefined;
}

function parseQty(v) {
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30));
function parseDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    return new Date(EXCEL_EPOCH.getTime() + v * 86400000);
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  // DD.MM.YYYY or DD/MM/YYYY
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapProductType(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "npd") return "NEW";
  return "EXISTING"; // "Existing", "Existence", anything else
}

async function main() {
  const fallbackBdEmail = process.env.FALLBACK_BD_EMAIL ?? "bd@fls.local";
  const fallbackBd = await prisma.user.findUniqueOrThrow({ where: { email: fallbackBdEmail } });

  const wb = XLSX.readFile(SOURCE_FILE, { cellDates: true });
  const sheet = wb.Sheets["TEMPLATE"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = {
    bdPerson: header.indexOf("bd person"),
    orderDate: header.indexOf("order date"),
    poNo: header.indexOf("po no."),
    customer: header.indexOf("customer"),
    productType: header.indexOf("product type"),
    productName: header.indexOf("product name"),
    qty: header.indexOf("order qty."),
    skuKg: header.indexOf("sku( kg )"),
  };

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== ""));

  // Resolve every existing customer once.
  const existingCustomers = await prisma.customer.findMany({ select: { id: true, companyName: true } });
  const customerByName = new Map(existingCustomers.map((c) => [c.companyName.trim().toLowerCase(), c.id]));

  function resolveCustomerKey(rawName) {
    const key = rawName.trim().toLowerCase();
    return CUSTOMER_ALIAS[key] ?? key;
  }

  // Group rows into (poNumber + customer) POs, in first-seen order.
  const groups = new Map(); // groupKey -> { poNumber, customerRawName, orderDate, items: [] }
  const skippedBadRows = [];

  for (const r of dataRows) {
    const poNo = cellToString(r[col.poNo]);
    const customerRaw = cellToString(r[col.customer]);
    const productName = cellToString(r[col.productName]);
    const qty = parseQty(r[col.qty]);
    if (!poNo || !customerRaw || !productName || qty === null) {
      skippedBadRows.push(r);
      continue;
    }
    const custKey = resolveCustomerKey(customerRaw);
    const groupKey = `${poNo}||${custKey}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        poNumber: poNo,
        customerKey: custKey,
        customerDisplayName: customerRaw,
        orderDate: parseDate(r[col.orderDate]),
        items: [],
      });
    }
    const skuKg = cellToString(r[col.skuKg]);
    groups.get(groupKey).items.push({
      productName,
      quantity: qty,
      unit: "SKU",
      productType: mapProductType(r[col.productType]),
      packSize: skuKg ? `${skuKg} Kg/unit` : undefined,
    });
  }

  console.log(`Parsed ${dataRows.length} rows -> ${groups.size} PO groups (${skippedBadRows.length} rows skipped for missing data).`);

  // Existing PO numbers (skip anything already imported, same rule the
  // app's own bulk import uses) — checked per (poNumber) since that's
  // the only uniqueness signal available; a real collision is unlikely
  // given how specific these PO numbers are.
  const existingPoNumbers = new Set((await prisma.purchaseOrder.findMany({ select: { poNumber: true } })).map((p) => p.poNumber));

  let posCreated = 0;
  let itemsCreated = 0;
  let customersCreated = 0;
  let skippedExisting = 0;

  for (const group of groups.values()) {
    if (group.poNumber && existingPoNumbers.has(group.poNumber)) {
      skippedExisting++;
      continue;
    }

    let customerId = customerByName.get(group.customerKey);
    if (!customerId) {
      const created = await prisma.customer.create({ data: { companyName: group.customerDisplayName, createdById: fallbackBd.id } });
      customerId = created.id;
      customerByName.set(group.customerKey, customerId);
      customersCreated++;
    }

    const baseCreatedAt = Date.now();
    const po = await prisma.purchaseOrder.create({
      data: {
        customerId,
        poNumber: group.poNumber,
        orderDate: group.orderDate,
        createdById: fallbackBd.id,
        items: {
          create: group.items.map((item, idx) => ({ ...item, createdAt: new Date(baseCreatedAt + idx) })),
        },
      },
    });
    posCreated++;
    itemsCreated += group.items.length;
  }

  console.log("\n=== DONE ===");
  console.log(`POs created: ${posCreated}, items created: ${itemsCreated}, new customers: ${customersCreated}, skipped (PO number already exists): ${skippedExisting}`);
  if (skippedBadRows.length) console.log(`Skipped ${skippedBadRows.length} rows with missing customer/product/qty.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
