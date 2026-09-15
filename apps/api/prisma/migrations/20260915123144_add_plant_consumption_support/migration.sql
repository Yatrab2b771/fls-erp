-- CreateEnum
CREATE TYPE "StockTransferSourceType" AS ENUM ('DAY_STORE', 'PLANT');

-- AlterEnum
ALTER TYPE "BatchConsumptionPurpose" ADD VALUE 'REJECTED';

-- DropForeignKey
ALTER TABLE "stock_transfers" DROP CONSTRAINT "stock_transfers_sourceDayStoreId_fkey";

-- AlterTable
ALTER TABLE "stock_transfers" ADD COLUMN     "preProductionId" TEXT,
ADD COLUMN     "sourcePlantId" TEXT,
ADD COLUMN     "sourceType" "StockTransferSourceType" NOT NULL DEFAULT 'DAY_STORE',
ALTER COLUMN "sourceDayStoreId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "stock_transfers_sourcePlantId_idx" ON "stock_transfers"("sourcePlantId");

-- CreateIndex
CREATE INDEX "stock_transfers_preProductionId_idx" ON "stock_transfers"("preProductionId");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sourceDayStoreId_fkey" FOREIGN KEY ("sourceDayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sourcePlantId_fkey" FOREIGN KEY ("sourcePlantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

