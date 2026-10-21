-- Approved vendors per product and material, and R&D's per-product deviations.
CREATE TABLE "product_material_vendors" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_material_vendors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_material_vendors_kind_scopeId_itemId_vendorId_key" ON "product_material_vendors"("kind", "scopeId", "itemId", "vendorId");
CREATE INDEX "product_material_vendors_kind_scopeId_idx" ON "product_material_vendors"("kind", "scopeId");
CREATE INDEX "product_material_vendors_itemId_idx" ON "product_material_vendors"("itemId");
ALTER TABLE "product_material_vendors" ADD CONSTRAINT "product_material_vendors_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_material_vendors" ADD CONSTRAINT "product_material_vendors_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "vendor_deviations" (
  "id" TEXT NOT NULL,
  "purchaseOrderItemId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "approvedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_deviations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_deviations_purchaseOrderItemId_itemId_key" ON "vendor_deviations"("purchaseOrderItemId", "itemId");
