-- Product-level Utilization: the four numbers entered for a whole batch, and the link from a Recycle Store row back to the batch that wrote it.
CREATE TABLE "batch_utilization_sheets" (
  "id" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "producedQty" DOUBLE PRECISION NOT NULL,
  "wasteQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rejectQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sampleQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "savedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "batch_utilization_sheets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "batch_utilization_sheets_productionBatchId_category_key" ON "batch_utilization_sheets"("productionBatchId", "category");
ALTER TABLE "batch_utilization_sheets" ADD CONSTRAINT "batch_utilization_sheets_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_transactions" ADD COLUMN "productionBatchId" TEXT;
CREATE INDEX "inventory_transactions_productionBatchId_idx" ON "inventory_transactions"("productionBatchId");
