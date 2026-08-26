-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "batchNo" TEXT,
ADD COLUMN     "expiryDate" TIMESTAMP(3),
ADD COLUMN     "grnNo" TEXT,
ADD COLUMN     "mfgDate" TIMESTAMP(3),
ADD COLUMN     "remark" TEXT;
