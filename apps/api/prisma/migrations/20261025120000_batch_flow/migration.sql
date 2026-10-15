-- The per-batch flow: preparation stages on each batch, the batch number serial, and what was dispensed for a batch.
CREATE TYPE "BatchPrepStage" AS ENUM ('INDENT_ISSUE', 'BATCH_NO', 'DISPENSING', 'LINE_CLEARANCE', 'READY');

ALTER TABLE "pre_productions" ADD COLUMN "batchFlow" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "production_batches"
  ADD COLUMN "prepStageId" "BatchPrepStage" NOT NULL DEFAULT 'READY',
  ADD COLUMN "prodIndentSlipSign" TEXT,
  ADD COLUMN "productionPlanDate" TIMESTAMP(3),
  ADD COLUMN "indentSignedAt" TIMESTAMP(3),
  ADD COLUMN "batchNoAllocatedAt" TIMESTAMP(3),
  ADD COLUMN "batchNoAllocatedById" TEXT,
  ADD COLUMN "rmDispensingDate" TIMESTAMP(3),
  ADD COLUMN "pmIssuedDate" TIMESTAMP(3),
  ADD COLUMN "dispensingRemarks" TEXT,
  ADD COLUMN "dispensedAt" TIMESTAMP(3),
  ADD COLUMN "grnNo" TEXT,
  ADD COLUMN "lineClearanceStatus" TEXT,
  ADD COLUMN "lineClearanceRemarks" TEXT,
  ADD COLUMN "lineClearanceAt" TIMESTAMP(3),
  ADD COLUMN "packagingShift" TEXT,
  ADD COLUMN "packagingManpowerCount" INTEGER,
  ADD COLUMN "packagingStartAt" TIMESTAMP(3),
  ADD COLUMN "packagingEndAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "production_batches_batchNo_key" ON "production_batches"("batchNo");
CREATE INDEX "production_batches_prepStageId_idx" ON "production_batches"("prepStageId");

CREATE TABLE "batch_no_counters" (
  "key" TEXT NOT NULL,
  "last" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "batch_no_counters_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "batch_dispensing_lines" (
  "id" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "batch_dispensing_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_dispensing_lines_productionBatchId_idx" ON "batch_dispensing_lines"("productionBatchId");

ALTER TABLE "batch_dispensing_lines" ADD CONSTRAINT "batch_dispensing_lines_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
