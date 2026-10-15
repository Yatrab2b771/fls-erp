-- AlterTable
ALTER TABLE "batch_material_consumptions" ADD COLUMN "productionBatchId" TEXT;
ALTER TABLE "stock_transfers" ADD COLUMN "productionBatchId" TEXT;

-- CreateIndex
CREATE INDEX "batch_material_consumptions_productionBatchId_idx" ON "batch_material_consumptions"("productionBatchId");

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
