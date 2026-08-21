-- AlterTable
ALTER TABLE "dispatch_transfers" ADD COLUMN     "dispatchNote" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedById" TEXT,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "invoicedAt" TIMESTAMP(3),
ADD COLUMN     "invoicedById" TEXT,
ADD COLUMN     "plantId" TEXT;

-- AlterTable
ALTER TABLE "inventory_requests" ADD COLUMN     "plantId" TEXT;

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "dayStoreId" TEXT,
ADD COLUMN     "plantId" TEXT;

-- CreateTable
CREATE TABLE "day_stores" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_inventory_requirements" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "requiredQty" DOUBLE PRECISION NOT NULL,
    "size" TEXT,
    "note" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "availableQty" DOUBLE PRECISION,
    "availableById" TEXT,
    "availableAt" TIMESTAMP(3),
    "poNumber" TEXT,
    "vendorName" TEXT,
    "eta" TIMESTAMP(3),
    "purchaseById" TEXT,
    "purchaseAt" TIMESTAMP(3),

    CONSTRAINT "pre_inventory_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "day_stores_name_key" ON "day_stores"("name");

-- CreateIndex
CREATE UNIQUE INDEX "plants_name_key" ON "plants"("name");

-- CreateIndex
CREATE INDEX "pre_inventory_requirements_category_idx" ON "pre_inventory_requirements"("category");

-- CreateIndex
CREATE INDEX "pre_inventory_requirements_itemId_idx" ON "pre_inventory_requirements"("itemId");

-- CreateIndex
CREATE INDEX "dispatch_transfers_plantId_idx" ON "dispatch_transfers"("plantId");

-- CreateIndex
CREATE INDEX "inventory_transactions_dayStoreId_idx" ON "inventory_transactions"("dayStoreId");

-- CreateIndex
CREATE INDEX "inventory_transactions_plantId_idx" ON "inventory_transactions"("plantId");

-- AddForeignKey
ALTER TABLE "day_stores" ADD CONSTRAINT "day_stores_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plants" ADD CONSTRAINT "plants_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_inventory_requirements" ADD CONSTRAINT "pre_inventory_requirements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_inventory_requirements" ADD CONSTRAINT "pre_inventory_requirements_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_inventory_requirements" ADD CONSTRAINT "pre_inventory_requirements_availableById_fkey" FOREIGN KEY ("availableById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_inventory_requirements" ADD CONSTRAINT "pre_inventory_requirements_purchaseById_fkey" FOREIGN KEY ("purchaseById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_dayStoreId_fkey" FOREIGN KEY ("dayStoreId") REFERENCES "day_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_invoicedById_fkey" FOREIGN KEY ("invoicedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

