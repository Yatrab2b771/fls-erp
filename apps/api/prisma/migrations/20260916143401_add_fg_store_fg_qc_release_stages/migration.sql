ALTER TYPE "CombinedLotStageId" ADD VALUE 'FG_STORE' BEFORE 'BILLING_EWAY_BILL';
ALTER TYPE "CombinedLotStageId" ADD VALUE 'FG_QC_RELEASE' BEFORE 'BILLING_EWAY_BILL';

ALTER TABLE "production_batches" ADD COLUMN "bulkTheoreticalWeight" DOUBLE PRECISION;
ALTER TABLE "production_batches" ADD COLUMN "bulkActualWeight" DOUBLE PRECISION;
ALTER TABLE "production_batches" ADD COLUMN "bulkQcSampleWeight" DOUBLE PRECISION;
ALTER TABLE "production_batches" ADD COLUMN "bulkTransferToPackingQty" DOUBLE PRECISION;

ALTER TABLE "production_batches" ADD COLUMN "fgStoreReceivedDate" TIMESTAMP(3);
ALTER TABLE "production_batches" ADD COLUMN "fgStoreRemarks" TEXT;

ALTER TABLE "production_batches" ADD COLUMN "fgQaStatus" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "fgQcStatus" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "fgRemarks" TEXT;

ALTER TABLE "production_batches" ADD COLUMN "pickedBy" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "pickingDate" TIMESTAMP(3);
ALTER TABLE "production_batches" ADD COLUMN "loadedBy" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "loadingDate" TIMESTAMP(3);
