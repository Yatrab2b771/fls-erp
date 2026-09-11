-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BatchStageId" ADD VALUE 'LINE_CLEARANCE';
ALTER TYPE "BatchStageId" ADD VALUE 'IPQC';
ALTER TYPE "BatchStageId" ADD VALUE 'BULK_QC';

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "bulkQcRemarks" TEXT,
ADD COLUMN     "bulkQcStatus" TEXT,
ADD COLUMN     "ipqcRemarks" TEXT,
ADD COLUMN     "ipqcStatus" TEXT,
ADD COLUMN     "lineClearanceRemarks" TEXT,
ADD COLUMN     "lineClearanceStatus" TEXT;
