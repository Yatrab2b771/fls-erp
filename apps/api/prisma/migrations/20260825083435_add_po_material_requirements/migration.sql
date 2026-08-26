-- CreateTable
CREATE TABLE "po_material_requirements" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "requiredQty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "po_material_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "po_material_requirements_purchaseOrderId_idx" ON "po_material_requirements"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "po_material_requirements_itemId_idx" ON "po_material_requirements"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "po_material_requirements_purchaseOrderId_itemId_key" ON "po_material_requirements"("purchaseOrderId", "itemId");

-- AddForeignKey
ALTER TABLE "po_material_requirements" ADD CONSTRAINT "po_material_requirements_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_material_requirements" ADD CONSTRAINT "po_material_requirements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_material_requirements" ADD CONSTRAINT "po_material_requirements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
