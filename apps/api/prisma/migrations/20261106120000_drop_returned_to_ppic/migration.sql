-- "Return to PPIC" was replaced by Production's own Cancel, so its columns are not needed.
ALTER TABLE "purchase_order_items" DROP COLUMN "returnedToPpicAt";
ALTER TABLE "purchase_order_items" DROP COLUMN "returnedToPpicById";
ALTER TABLE "purchase_order_items" DROP COLUMN "returnedToPpicReason";
