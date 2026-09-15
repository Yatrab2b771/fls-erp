-- CreateEnum
CREATE TYPE "StockTransferDestinationType" AS ENUM ('DAY_STORE', 'WAREHOUSE', 'PLANT');

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "isStockTransferReceipt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stockTransferId" TEXT;

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "sourceDayStoreId" TEXT NOT NULL,
    "destinationType" "StockTransferDestinationType" NOT NULL,
    "destDayStoreId" TEXT,
    "destPlantId" TEXT,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfers_itemId_idx" ON "stock_transfers"("itemId");

-- CreateIndex
CREATE INDEX "stock_transfers_sourceDayStoreId_idx" ON "stock_transfers"("sourceDayStoreId");

-- CreateIndex
CREATE INDEX "stock_transfers_destinationType_confirmedAt_idx" ON "stock_transfers"("destinationType", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_stockTransferId_key" ON "inventory_transactions"("stockTransferId");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sourceDayStoreId_fkey" FOREIGN KEY ("sourceDayStoreId") REFERENCES "day_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destDayStoreId_fkey" FOREIGN KEY ("destDayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destPlantId_fkey" FOREIGN KEY ("destPlantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "stock_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

