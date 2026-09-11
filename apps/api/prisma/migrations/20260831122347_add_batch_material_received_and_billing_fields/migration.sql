-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "billingRemarks" TEXT,
ADD COLUMN     "ewayBillDate" TIMESTAMP(3),
ADD COLUMN     "ewayBillNo" TEXT,
ADD COLUMN     "grnDate" TIMESTAMP(3),
ADD COLUMN     "grnNo" TEXT,
ADD COLUMN     "invoiceDate" TIMESTAMP(3),
ADD COLUMN     "invoiceNo" TEXT,
ADD COLUMN     "materialReceivedRemarks" TEXT;
