-- AlterEnum
ALTER TYPE "InventoryReceiptStatus" ADD VALUE 'TESTING';

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN "samplingDate" TIMESTAMP(3);
