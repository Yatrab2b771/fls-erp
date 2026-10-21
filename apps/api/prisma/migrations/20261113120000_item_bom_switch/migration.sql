-- Which BOM version (Display / V1 / V2) a product's plan is made from, and the log of every change.
ALTER TABLE "purchase_order_items" ADD COLUMN "activeBomSlot" TEXT NOT NULL DEFAULT 'DISPLAY';
ALTER TABLE "purchase_order_items" ADD COLUMN "activeBomChangedAt" TIMESTAMP(3);
ALTER TABLE "purchase_order_items" ADD COLUMN "activeBomChangedById" TEXT;

CREATE TABLE "item_bom_switches" (
  "id" TEXT NOT NULL,
  "purchaseOrderItemId" TEXT NOT NULL,
  "fromSlot" TEXT NOT NULL,
  "toSlot" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'PLANNING',
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "item_bom_switches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "item_bom_switches_purchaseOrderItemId_idx" ON "item_bom_switches"("purchaseOrderItemId");
ALTER TABLE "item_bom_switches" ADD CONSTRAINT "item_bom_switches_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
