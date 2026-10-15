CREATE TYPE "ItemChangeKind" AS ENUM ('HOLD', 'CANCEL');
CREATE TYPE "ItemChangeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
CREATE TABLE "item_change_requests" (
  "id" TEXT NOT NULL,
  "purchaseOrderItemId" TEXT NOT NULL,
  "kind" "ItemChangeKind" NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "ItemChangeStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  CONSTRAINT "item_change_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "item_change_requests_status_idx" ON "item_change_requests"("status");
CREATE INDEX "item_change_requests_purchaseOrderItemId_idx" ON "item_change_requests"("purchaseOrderItemId");
ALTER TABLE "item_change_requests" ADD CONSTRAINT "item_change_requests_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_change_requests" ADD CONSTRAINT "item_change_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item_change_requests" ADD CONSTRAINT "item_change_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
