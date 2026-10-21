-- Production closes a product short: it ends at what was made, not the ordered quantity.
ALTER TABLE "purchase_order_items" ADD COLUMN "closedShortAt" TIMESTAMP(3);
ALTER TABLE "purchase_order_items" ADD COLUMN "closedShortById" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "closedShortReason" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "closedShortQty" DOUBLE PRECISION;
