-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "bulkActualWeight" DOUBLE PRECISION,
ADD COLUMN     "bulkQcSampleWeight" DOUBLE PRECISION,
ADD COLUMN     "bulkTheoreticalWeight" DOUBLE PRECISION,
ADD COLUMN     "bulkTransferToPackingQty" DOUBLE PRECISION;
