-- A manual Pre-Inventory requirement can be tied to a customer PO product (display only).
ALTER TABLE "pre_inventory_requirements" ADD COLUMN "linkedPoItemId" TEXT;
