-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "plantId" TEXT;

-- CreateTable
CREATE TABLE "batch_material_consumptions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_material_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_material_consumptions_batchId_idx" ON "batch_material_consumptions"("batchId");

-- CreateIndex
CREATE INDEX "batch_material_consumptions_itemId_idx" ON "batch_material_consumptions"("itemId");

-- CreateIndex
CREATE INDEX "batches_plantId_idx" ON "batches"("plantId");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
