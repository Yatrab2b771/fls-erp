-- Reworks of customer-returned goods: a small job in New Plan, tagged Rework, with a sub-number of the original batch.
CREATE TABLE "reworks" (
  "id" TEXT NOT NULL,
  "reworkNo" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "customerReturnId" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "shift" TEXT,
  "manpowerCount" INTEGER,
  "startAt" TIMESTAMP(3),
  "endAt" TIMESTAMP(3),
  "outputQty" DOUBLE PRECISION,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  CONSTRAINT "reworks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reworks_reworkNo_key" ON "reworks"("reworkNo");
CREATE INDEX "reworks_customerReturnId_idx" ON "reworks"("customerReturnId");
CREATE INDEX "reworks_productionBatchId_idx" ON "reworks"("productionBatchId");
ALTER TABLE "reworks" ADD CONSTRAINT "reworks_customerReturnId_fkey" FOREIGN KEY ("customerReturnId") REFERENCES "customer_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reworks" ADD CONSTRAINT "reworks_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "batch_material_consumptions" ADD COLUMN "reworkId" TEXT;
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_reworkId_fkey" FOREIGN KEY ("reworkId") REFERENCES "reworks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
