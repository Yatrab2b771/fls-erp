-- Stock integrity: approved stock adjustments, rejected-stock dispositions, lot traceability, short-receipt on transfers,
-- actual weighing at dispensing, and the per-batch flow feeding the Recycle Store.

-- ---------------------------------------------------------------- transit: short receipt / refusal
ALTER TABLE "inventory_transactions"
  ADD COLUMN "shortQty" DOUBLE PRECISION,
  ADD COLUMN "shortNote" TEXT,
  ADD COLUMN "rndTransferId" TEXT;
CREATE INDEX "inventory_transactions_rndTransferId_idx" ON "inventory_transactions"("rndTransferId");

ALTER TABLE "stock_transfers"
  ADD COLUMN "shortQty" DOUBLE PRECISION,
  ADD COLUMN "shortNote" TEXT,
  ADD COLUMN "rejectedReason" TEXT;

ALTER TABLE "rnd_transfers"
  ADD COLUMN "shortQty" DOUBLE PRECISION,
  ADD COLUMN "shortNote" TEXT,
  ADD COLUMN "rejectedReason" TEXT;

-- ---------------------------------------------------------------- dispensing: what was actually weighed
ALTER TABLE "batch_dispensing_lines"
  ADD COLUMN "plannedQty" DOUBLE PRECISION,
  ADD COLUMN "grossWeight" DOUBLE PRECISION,
  ADD COLUMN "tareWeight" DOUBLE PRECISION,
  ADD COLUMN "arNo" TEXT,
  ADD COLUMN "note" TEXT;
-- Lines made before this existed were always the plan quantity.
UPDATE "batch_dispensing_lines" SET "plannedQty" = "quantity" WHERE "plannedQty" IS NULL;

-- ---------------------------------------------------------------- recycle log also for the per-batch flow
ALTER TABLE "batch_recycle_logs"
  ALTER COLUMN "combinedLotId" DROP NOT NULL,
  ADD COLUMN "productionBatchId" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'WASTAGE';
ALTER TABLE "batch_recycle_logs" DROP CONSTRAINT "batch_recycle_logs_combinedLotId_fkey";
ALTER TABLE "batch_recycle_logs" ADD CONSTRAINT "batch_recycle_logs_combinedLotId_fkey" FOREIGN KEY ("combinedLotId") REFERENCES "combined_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "batch_recycle_logs" ADD CONSTRAINT "batch_recycle_logs_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "batch_recycle_logs_productionBatchId_idx" ON "batch_recycle_logs"("productionBatchId");

-- ---------------------------------------------------------------- stock adjustments
CREATE TYPE "StockAdjustmentLocation" AS ENUM ('WAREHOUSE', 'DAY_STORE', 'PLANT', 'RND_STORE');
CREATE TYPE "StockAdjustmentReason" AS ENUM ('COUNT_CORRECTION', 'DAMAGED', 'SPILLAGE', 'EXPIRED_DISPOSAL', 'FOUND_EXTRA', 'OTHER');
CREATE TYPE "StockAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "stock_adjustments" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationType" "StockAdjustmentLocation" NOT NULL,
  "dayStoreId" TEXT,
  "plantId" TEXT,
  "quantityDelta" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "reason" "StockAdjustmentReason" NOT NULL,
  "note" TEXT NOT NULL,
  "systemQty" DOUBLE PRECISION,
  "countedQty" DOUBLE PRECISION,
  "status" "StockAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_adjustments_status_idx" ON "stock_adjustments"("status");
CREATE INDEX "stock_adjustments_itemId_locationType_status_idx" ON "stock_adjustments"("itemId", "locationType", "status");
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_dayStoreId_fkey" FOREIGN KEY ("dayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- rejected stock leaving the building
CREATE TYPE "RejectedDispositionKind" AS ENUM ('RETURNED_TO_VENDOR', 'DESTROYED');

CREATE TABLE "rejected_dispositions" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "kind" "RejectedDispositionKind" NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "challanNo" TEXT,
  "vehicleNo" TEXT,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "rejected_dispositions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rejected_dispositions_receiptId_idx" ON "rejected_dispositions"("receiptId");
ALTER TABLE "rejected_dispositions" ADD CONSTRAINT "rejected_dispositions_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- lot traceability
CREATE TABLE "lot_allocations" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "issueTxnId" TEXT,
  "dispensingLineId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lot_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lot_allocations_receiptId_idx" ON "lot_allocations"("receiptId");
CREATE INDEX "lot_allocations_issueTxnId_idx" ON "lot_allocations"("issueTxnId");
CREATE INDEX "lot_allocations_dispensingLineId_idx" ON "lot_allocations"("dispensingLineId");
CREATE INDEX "lot_allocations_itemId_idx" ON "lot_allocations"("itemId");
ALTER TABLE "lot_allocations" ADD CONSTRAINT "lot_allocations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_allocations" ADD CONSTRAINT "lot_allocations_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_allocations" ADD CONSTRAINT "lot_allocations_issueTxnId_fkey" FOREIGN KEY ("issueTxnId") REFERENCES "inventory_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lot_allocations" ADD CONSTRAINT "lot_allocations_dispensingLineId_fkey" FOREIGN KEY ("dispensingLineId") REFERENCES "batch_dispensing_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
