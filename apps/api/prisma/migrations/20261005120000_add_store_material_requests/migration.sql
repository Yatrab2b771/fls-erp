-- A Day Store can ask the Warehouse for material; a short request can become a purchase need.
ALTER TABLE "inventory_requests" ADD COLUMN "requestingDayStoreId" TEXT;
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_requestingDayStoreId_fkey" FOREIGN KEY ("requestingDayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "inventory_requests_requestingDayStoreId_idx" ON "inventory_requests"("requestingDayStoreId");

ALTER TABLE "pre_inventory_requirements" ADD COLUMN "sourceRequestId" TEXT;
ALTER TABLE "pre_inventory_requirements" ADD COLUMN "sourceRndRequestId" TEXT;
CREATE INDEX "pre_inventory_requirements_sourceRequestId_idx" ON "pre_inventory_requirements"("sourceRequestId");
CREATE INDEX "pre_inventory_requirements_sourceRndRequestId_idx" ON "pre_inventory_requirements"("sourceRndRequestId");
