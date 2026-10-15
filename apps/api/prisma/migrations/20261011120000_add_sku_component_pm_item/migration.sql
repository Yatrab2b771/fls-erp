ALTER TABLE "sku_packaging_components" ADD COLUMN "pmItemId" TEXT;
ALTER TABLE "sku_packaging_components" ADD CONSTRAINT "sku_packaging_components_pmItemId_fkey" FOREIGN KEY ("pmItemId") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
