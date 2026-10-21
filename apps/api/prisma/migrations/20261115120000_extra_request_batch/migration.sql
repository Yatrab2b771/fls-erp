-- An extra material request can be for one batch (R&D changed the BOM after the batch was dispensed).
ALTER TABLE "inventory_requests" ADD COLUMN "productionBatchId" TEXT;
CREATE INDEX "inventory_requests_productionBatchId_idx" ON "inventory_requests"("productionBatchId");
