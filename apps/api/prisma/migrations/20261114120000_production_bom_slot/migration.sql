-- R&D can change the BOM version of a product that is already with Production, without PPIC seeing it.
ALTER TABLE "purchase_order_items" ADD COLUMN "productionBomSlot" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "bomSlot" TEXT;
