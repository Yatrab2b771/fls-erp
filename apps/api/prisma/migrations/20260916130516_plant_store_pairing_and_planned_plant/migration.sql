-- AlterTable
ALTER TABLE "plants" ADD COLUMN     "dayStoreId" TEXT;

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "plannedPlantId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "plants_dayStoreId_key" ON "plants"("dayStoreId");

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_plannedPlantId_fkey" FOREIGN KEY ("plannedPlantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plants" ADD CONSTRAINT "plants_dayStoreId_fkey" FOREIGN KEY ("dayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

