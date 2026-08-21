-- AlterEnum
ALTER TYPE "InventoryRequestStatus" ADD VALUE 'PARTIALLY_ISSUED';

-- DropIndex
DROP INDEX "inventory_transactions_fulfillsRequestId_key";

