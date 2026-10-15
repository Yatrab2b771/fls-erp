-- PM BOM sheet header + per-row overage / spec / make / level
ALTER TABLE "skus" ADD COLUMN "productCode" TEXT, ADD COLUMN "packSize" TEXT, ADD COLUMN "packingConfig" TEXT, ADD COLUMN "batchPacks" INTEGER;
ALTER TABLE "sku_packaging_components" ADD COLUMN "overagePct" DOUBLE PRECISION, ADD COLUMN "spec" TEXT, ADD COLUMN "make" TEXT, ADD COLUMN "packingLevel" TEXT;
-- RM BOM sheet: per Kg vs per gummy, header fields
ALTER TABLE "recipes" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PER_KG', ADD COLUMN "productCode" TEXT, ADD COLUMN "versionLabel" TEXT, ADD COLUMN "batchSize" DOUBLE PRECISION, ADD COLUMN "avgUnitWeightMg" DOUBLE PRECISION;
ALTER TABLE "recipe_ingredients" ADD COLUMN "uom" TEXT NOT NULL DEFAULT 'Kg';
-- Version history of every BOM save
CREATE TABLE "bom_versions" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "note" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bom_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bom_versions_kind_entityId_version_key" ON "bom_versions"("kind", "entityId", "version");
CREATE INDEX "bom_versions_kind_entityId_idx" ON "bom_versions"("kind", "entityId");
