-- A material request can name the customer PO product it is for, and a Day Store's request to the Warehouse can
-- point at the production request it fills (the plan-driven, urgent ones).
ALTER TABLE "inventory_requests" ADD COLUMN "purchaseOrderItemId" TEXT;
ALTER TABLE "inventory_requests" ADD COLUMN "forRequestId" TEXT;
CREATE INDEX "inventory_requests_purchaseOrderItemId_idx" ON "inventory_requests"("purchaseOrderItemId");
CREATE INDEX "inventory_requests_forRequestId_idx" ON "inventory_requests"("forRequestId");
