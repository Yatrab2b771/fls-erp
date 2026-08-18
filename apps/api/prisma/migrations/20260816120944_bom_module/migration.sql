-- CreateEnum
CREATE TYPE "BomPlanStatus" AS ENUM ('DRAFT', 'CALCULATED');

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "jar" TEXT,
    "wadMm" TEXT,
    "scoopMl" TEXT,
    "silicaGelGms" TEXT,
    "silicaGelQtyNos" TEXT,
    "authenticationSticker" TEXT,
    "capSticker" TEXT,
    "capLockSticker" TEXT,
    "neckSleeve" TEXT,
    "shrink" TEXT,
    "innerPackaging" TEXT,
    "leaflet" TEXT,
    "corrugatedBoxMm" TEXT,
    "packagingSizeNos" TEXT,
    "extra" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dateFrom" TIMESTAMP(3),
    "dateTo" TIMESTAMP(3),
    "status" "BomPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resultSnapshot" JSONB,
    "calculatedAt" TIMESTAMP(3),

    CONSTRAINT "bom_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_plan_items" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "targetYield" INTEGER NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "bom_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "skus_brandId_productName_key" ON "skus"("brandId", "productName");

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_plans" ADD CONSTRAINT "bom_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_plan_items" ADD CONSTRAINT "bom_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "bom_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_plan_items" ADD CONSTRAINT "bom_plan_items_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_plan_items" ADD CONSTRAINT "bom_plan_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
