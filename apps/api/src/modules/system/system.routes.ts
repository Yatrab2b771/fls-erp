import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import type { Prisma } from "@prisma/client";

// --- Admin-only operational tooling — a live snapshot of "is this
// actually working" (System Health) and a read view onto the AuditLog
// table every mutating action in this app already writes to via
// recordAudit() (Audit Log). Neither exposes any data that doesn't
// already exist; this only makes it visible from the UI instead of a
// direct DB query. Gated the same way Users/Recycle Bin already are —
// requireRole("ADMIN"), nothing narrower. ---

export const systemRouter = Router();

systemRouter.use(requireAuth);

systemRouter.get("/health", requireRole("ADMIN"), async (_req, res) => {
  try {
    const dbStart = Date.now();
    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    const database = rows[0]?.current_database ?? "unknown";
    const dbLatencyMs = Date.now() - dbStart;

    const [userCount, activeUserCount, batchCount, purchaseOrderCount, auditLogCount] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.preProduction.count(),
      prisma.purchaseOrder.count(),
      prisma.auditLog.count(),
    ]);

    const mem = process.memoryUsage();

    res.json({
      status: "ok",
      db: { connected: true, database, latencyMs: dbLatencyMs },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        env: process.env.NODE_ENV ?? "development",
        memoryMb: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024), heapTotal: Math.round(mem.heapTotal / 1024 / 1024) },
      },
      counts: { users: userCount, activeUsers: activeUserCount, batches: batchCount, purchaseOrders: purchaseOrderCount, auditLogEntries: auditLogCount },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    // A DB failure here is the one interesting case this panel exists
    // to surface — report it as a 200 "unhealthy" body, not a 500,
    // so the page can render a clear "DB unreachable" card instead of
    // just erroring out like every other endpoint's failure would.
    res.json({ status: "error", db: { connected: false }, error: err instanceof Error ? err.message : "Unknown error", checkedAt: new Date().toISOString() });
  }
});

systemRouter.get("/audit-log", requireRole("ADMIN"), async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const { action, entityType, actorId } = req.query as { action?: string; entityType?: string; actorId?: string };

    const where: Prisma.AuditLogWhereInput = {
      ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
      ...(entityType ? { entityType: { contains: entityType, mode: "insensitive" } } : {}),
      ...(actorId ? { actorId } : {}),
    };

    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, employeeId: true, fullName: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

// --- TEMPORARY one-off — runs the Purchase/Accounts/Dispatch demo-data
// additions from prisma/seed.ts against the live DB directly (the
// operator's own machine can't reach Neon right now to run the seed
// script locally). Same idempotency guards as the seed script itself;
// safe to call more than once. Remove this endpoint once it's been run.
systemRouter.post("/dev-seed-extra", requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const emails = {
      BD: "bd@fls.local",
      STORE: "store@fls.local",
      PURCHASE: "purchase@fls.local",
      ACCOUNTS: "accounts@fls.local",
      QA_QC: "qa_qc@fls.local",
      DISPATCH: "dispatch@fls.local",
    };
    const users = await prisma.user.findMany({ where: { email: { in: Object.values(emails) } } });
    const idByEmail = Object.fromEntries(users.map((u) => [u.email, u.id]));
    const bdId = idByEmail[emails.BD];
    const storeId = idByEmail[emails.STORE];
    const purchaseId = idByEmail[emails.PURCHASE];
    const accountsId = idByEmail[emails.ACCOUNTS];
    const qaId = idByEmail[emails.QA_QC];
    const dispatchId = idByEmail[emails.DISPATCH];

    const log: string[] = [];

    // --- Purchase & Accounts: pricing + a debit note ---
    if (purchaseId) {
      const wheyIsolate = await prisma.inventoryItem.findUnique({ where: { category_name: { category: "RM", name: "Whey Protein Isolate" } } });
      if (wheyIsolate && wheyIsolate.costPrice === null) {
        await prisma.inventoryItem.update({ where: { id: wheyIsolate.id }, data: { costPrice: 620, purchasePrice: 640, mrp: 950, salesPrice: 880 } });
      }
      const creatine = await prisma.inventoryItem.findUnique({ where: { category_name: { category: "RM", name: "Creatine Monohydrate" } } });
      if (creatine && creatine.costPrice === null) {
        await prisma.inventoryItem.update({ where: { id: creatine.id }, data: { costPrice: 810, purchasePrice: 830, mrp: 1200, salesPrice: 1100 } });
      }
      log.push("Set demo pricing on 2 catalog items.");

      if (wheyIsolate) {
        const receipt = await prisma.inventoryTransaction.findFirst({ where: { itemId: wheyIsolate.id, type: "RECEIVED" }, orderBy: { date: "asc" } });
        if (receipt && (await prisma.debitNote.count({ where: { transactionId: receipt.id } })) === 0) {
          await prisma.debitNote.create({
            data: {
              transactionId: receipt.id,
              debitNoteNo: "DN-2026-0031",
              date: new Date("2026-08-06"),
              vendorName: receipt.vendorName,
              itemId: wheyIsolate.id,
              quantity: 5,
              unit: "Kg",
              amount: 3100,
              reason: "5 Kg short-delivered against the GRN quantity.",
              createdById: purchaseId,
            },
          });
          log.push("Created demo debit note.");
        }
      }
    } else {
      log.push("Skipped Purchase/Accounts demo — no Purchase demo user found.");
    }

    // --- Full pipeline through to Dispatch Plan, for Accounts + Dispatch ---
    if (bdId && storeId && qaId && accountsId && dispatchId) {
      const v3Po = "PO-2026-0260";
      const already = await prisma.purchaseOrder.findFirst({ where: { poNumber: v3Po } });
      if (already) {
        log.push(`PO "${v3Po}" already exists — skipping.`);
      } else {
        const customer = await prisma.customer.findFirst({ where: { companyName: "Acme Wellness Retail Pvt. Ltd." } });
        if (!customer) {
          log.push("Skipped full-pipeline Dispatch demo — demo customer not found.");
        } else {
          const po = await prisma.purchaseOrder.create({
            data: {
              customerId: customer.id,
              createdById: bdId,
              poNumber: v3Po,
              orderDate: new Date("2026-08-01"),
              regulatoryBody: "FSSAI",
              regulatoryStatus: "Issued",
              status: "APPROVED",
              reviewedById: bdId,
              reviewedAt: new Date("2026-08-02"),
              items: { create: [{ productName: "Whey Gold 1kg", dosageForm: "Powders", quantity: 400, unit: "SKU", packSize: "1kg", packType: "Jar" }] },
            },
            include: { items: true },
          });
          const item = po.items[0]!;

          const pp = await prisma.preProduction.create({
            data: {
              purchaseOrderItemId: item.id,
              plannedQty: item.quantity,
              combinedQty: item.quantity,
              currentStageId: "SAMPLE_QC_APPROVAL",
              prodIndentSlipSign: "PPIC-IND-0260",
              productionPlanDate: new Date("2026-08-03"),
              unit: "41",
              dispatchPlanDate: new Date("2026-08-20"),
              lineClearanceStatus: "Approved",
              rmDispensingDate: new Date("2026-08-05"),
              sampleQcStatus: "Approved",
            },
          });
          await prisma.productionBatch.create({
            data: {
              preProductionId: pp.id,
              batchNo: "GB-WHEYGOLD-0260",
              plannedQty: item.quantity,
              status: "COMPLETED",
              manufacturingStartDate: new Date("2026-08-06"),
              manufacturingEndDate: new Date("2026-08-07"),
              manufacturingStatus: "Completed",
              inputQty: item.quantity + 15,
              outputQty: item.quantity,
              createdById: storeId,
              completedById: qaId,
              completedAt: new Date("2026-08-07"),
            },
          });

          const dispatchTransfer = await prisma.dispatchTransfer.create({
            data: { type: "FG", date: new Date("2026-08-20"), customerId: customer.id, productName: item.productName, quantity: item.quantity, createdById: dispatchId },
          });

          const cl = await prisma.combinedLot.create({
            data: {
              preProductionId: pp.id,
              currentStageId: "DISPATCH_PLAN",
              ipqcStatus: "Approved",
              mfgQaStatus: "Approved",
              mfgQcStatus: "Approved",
              mfgApprovedQty: item.quantity - 5,
              mfgRejectedQty: 2,
              mfgWastageQty: 3,
              bulkQcStatus: "Approved",
              coaResult: "Complies",
              coaAnalyzedById: qaId,
              coaAnalyzedAt: new Date("2026-08-10"),
              coaReviewedById: qaId,
              coaReviewedAt: new Date("2026-08-11"),
              coaApprovedById: qaId,
              coaApprovedAt: new Date("2026-08-12"),
              packagingStartDate: new Date("2026-08-13"),
              packagingEndDate: new Date("2026-08-14"),
              packagingStatus: "Completed",
              packQaStatus: "Approved",
              packQcStatus: "Approved",
              packApprovedQty: item.quantity - 5,
              invoiceNo: "INV-2026-0451",
              invoiceDate: new Date("2026-08-18"),
              ewayBillNo: "EWB-2026-0451",
              ewayBillDate: new Date("2026-08-18"),
              billingRemarks: "Invoice + E-Way Bill raised for the full dispatch quantity.",
              dispatchDate: new Date("2026-08-20"),
              dispatchedQty: item.quantity - 5,
              shipperQty: 40,
              totalShipperWeight: 410,
              transportType: "By Land",
              remainingQty: 0,
              dispatchTransferId: dispatchTransfer.id,
            },
          });
          await prisma.combinedLotStageEvent.createMany({
            data: [
              { combinedLotId: cl.id, fromStageId: "IPQC", toStageId: "QA_GATE_MFG", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-09") },
              { combinedLotId: cl.id, fromStageId: "QA_GATE_MFG", toStageId: "BULK_QC", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-10") },
              { combinedLotId: cl.id, fromStageId: "BULK_QC", toStageId: "PACKAGING", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-12") },
              { combinedLotId: cl.id, fromStageId: "PACKAGING", toStageId: "QA_GATE_PACKAGING", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-14") },
              { combinedLotId: cl.id, fromStageId: "QA_GATE_PACKAGING", toStageId: "BILLING_EWAY_BILL", action: "FORWARD", actorId: accountsId, createdAt: new Date("2026-08-18") },
              { combinedLotId: cl.id, fromStageId: "BILLING_EWAY_BILL", toStageId: "DISPATCH_PLAN", action: "FORWARD", actorId: dispatchId, createdAt: new Date("2026-08-20") },
            ],
          });
          log.push(`Created PO "${v3Po}" walked through to Dispatch Plan.`);
        }
      }
    } else {
      log.push("Skipped full-pipeline Dispatch demo — a required demo user was missing.");
    }

    res.json({ ok: true, log });
  } catch (err) {
    next(err);
  }
});
