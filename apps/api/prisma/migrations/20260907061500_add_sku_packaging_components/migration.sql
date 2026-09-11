-- CreateTable
CREATE TABLE "sku_packaging_components" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'Nos',
    "pmCode" TEXT,

    CONSTRAINT "sku_packaging_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sku_packaging_components_skuId_type_key" ON "sku_packaging_components"("skuId", "type");

-- AddForeignKey
ALTER TABLE "sku_packaging_components" ADD CONSTRAINT "sku_packaging_components_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
