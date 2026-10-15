import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";

/**
 * R&D's "New Material" list: every Material Received entry the Warehouse took in from a vendor, with where it stands in R&D's inward QC.
 *
 *   GET /   one row per receipt: vendor, material (RM / PM), quantity, received date, sampling date, status
 *           (Pending / Testing / On Hold / Approved / Rejected), and the date the status was last set (what Aging runs to)
 *
 * The status is changed with PATCH /api/inventory/transactions/:id/qc (R&D only; the sampling date is required there).
 * Opening stock, stock-transfer receipts and R&D returns are not "new material" and are left out.
 */
export const newMaterialRouter = Router();
newMaterialRouter.use(requireAuth, requireRole("RND"));

newMaterialRouter.get("/", async (_req, res, next) => {
  try {
    const select = {
      id: true,
      date: true,
      createdAt: true,
      quantity: true,
      rejectedQty: true,
      unit: true,
      vendorName: true,
      batchNo: true,
      grnNo: true,
      invoiceNo: true,
      receiptStatus: true,
      samplingDate: true,
      qcCheckedAt: true,
      qcNote: true,
      item: { select: { name: true, category: true } },
    } as const;
    const base = { type: "RECEIVED", deletedAt: null, isRndReturn: false, isStockTransferReceipt: false, isOpeningStock: false } as const;
    // Every entry still waiting on R&D, plus the most recent decided ones (so the list never grows without bound)
    const [open, decided] = await Promise.all([
      prisma.inventoryTransaction.findMany({ where: { ...base, receiptStatus: { in: ["PENDING_QC", "TESTING", "ON_HOLD"] } }, orderBy: { date: "desc" }, select }),
      prisma.inventoryTransaction.findMany({ where: { ...base, receiptStatus: { notIn: ["PENDING_QC", "TESTING", "ON_HOLD"] } }, orderBy: { date: "desc" }, take: 1500, select }),
    ]);
    const rows = [...open, ...decided].sort((a, b) => b.date.getTime() - a.date.getTime());
    res.json(
      rows.map((r) => ({
        id: r.id,
        vendorName: r.vendorName,
        itemName: r.item.name,
        category: r.item.category,
        quantity: r.quantity,
        unit: r.unit,
        batchNo: r.batchNo,
        grnNo: r.grnNo,
        invoiceNo: r.invoiceNo,
        receivedAt: r.date,
        samplingDate: r.samplingDate,
        status: r.receiptStatus,
        statusAt: r.qcCheckedAt,
        note: r.qcNote,
      })),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * R&D's "Quarantine" list - GET /api/inventory/new-material/quarantine
 * Material the Warehouse has received that is NOT usable stock right now:
 *   Pending / Testing / On Hold   not approved by R&D yet (R&D can Approve, Reject, Hold, or mark Testing)
 *   Rejected                      failed inward QC (final)
 *   Expired                       accepted earlier but now past its expiry date and not released (R&D can Approve = release)
 * Approving takes a row out of this list. Stock-transfer receipts and R&D returns are not vendor deliveries and are left out.
 */
newMaterialRouter.get("/quarantine", async (_req, res, next) => {
  try {
    const now = new Date();
    const rows = await prisma.inventoryTransaction.findMany({
      where: {
        type: "RECEIVED",
        deletedAt: null,
        isRndReturn: false,
        isStockTransferReceipt: false,
        OR: [{ receiptStatus: { in: ["PENDING_QC", "TESTING", "ON_HOLD", "QC_REJECTED"] }, isOpeningStock: false }, { receiptStatus: "ACCEPTED", expiryDate: { lt: now }, expiryReleasedAt: null }],
      },
      orderBy: { date: "desc" },
      take: 3000,
      select: {
        id: true,
        date: true,
        quantity: true,
        rejectedQty: true,
        unit: true,
        vendorName: true,
        batchNo: true,
        grnNo: true,
        invoiceNo: true,
        expiryDate: true,
        receiptStatus: true,
        samplingDate: true,
        qcCheckedAt: true,
        qcNote: true,
        item: { select: { name: true, category: true } },
      },
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        vendorName: r.vendorName,
        itemName: r.item.name,
        category: r.item.category,
        quantity: r.quantity,
        rejectedQty: r.rejectedQty,
        unit: r.unit,
        batchNo: r.batchNo,
        grnNo: r.grnNo,
        invoiceNo: r.invoiceNo,
        receivedAt: r.date,
        samplingDate: r.samplingDate,
        expiryDate: r.expiryDate,
        // Accepted + in this list can only mean expired
        reason: r.receiptStatus === "ACCEPTED" ? "EXPIRED" : r.receiptStatus === "QC_REJECTED" ? "REJECTED" : r.receiptStatus === "ON_HOLD" ? "ON_HOLD" : r.receiptStatus === "TESTING" ? "TESTING" : "PENDING_QC",
        statusAt: r.qcCheckedAt,
        note: r.qcNote,
      })),
    );
  } catch (err) {
    next(err);
  }
});
