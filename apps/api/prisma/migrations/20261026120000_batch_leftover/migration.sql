-- E · Return of a batch's Utilization: leftover material that stays in the Plant's stock until it is sent back to the Day Store.
CREATE TABLE "batch_leftovers" (
  "id" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "returnedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unit" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "batch_leftovers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_leftovers_productionBatchId_idx" ON "batch_leftovers"("productionBatchId");
CREATE INDEX "batch_leftovers_itemId_idx" ON "batch_leftovers"("itemId");

ALTER TABLE "batch_leftovers" ADD CONSTRAINT "batch_leftovers_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
