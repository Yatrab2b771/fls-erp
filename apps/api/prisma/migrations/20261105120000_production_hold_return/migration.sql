-- Production's own hold on a product, and its "return the plan to PPIC".
ALTER TABLE "purchase_order_items" ADD COLUMN "productionHeldAt" TIMESTAMP(3);
ALTER TABLE "purchase_order_items" ADD COLUMN "productionHeldById" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "productionHoldReason" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "returnedToPpicAt" TIMESTAMP(3);
ALTER TABLE "purchase_order_items" ADD COLUMN "returnedToPpicById" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "returnedToPpicReason" TEXT;
