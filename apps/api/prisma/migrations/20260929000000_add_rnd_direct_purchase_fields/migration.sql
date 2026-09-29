-- AlterTable
ALTER TABLE "rnd_store_transactions" ADD COLUMN     "vendorName" TEXT,
ADD COLUMN     "invoiceNo" TEXT,
ADD COLUMN     "expiryDate" TIMESTAMP(3);
