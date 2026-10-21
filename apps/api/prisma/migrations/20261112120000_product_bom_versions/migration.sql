-- A product's alternative BOMs (V1, V2) next to the catalog's own Display BOM.
CREATE TABLE "product_bom_versions" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "productKey" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "slot" TEXT NOT NULL,
  "rmSnapshot" JSONB,
  "pmSnapshot" JSONB,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_bom_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_bom_versions_customerId_productKey_slot_key" ON "product_bom_versions"("customerId", "productKey", "slot");
