-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "vendorPurchaseOrderItemId" TEXT;

-- AlterTable
ALTER TABLE "vendor_purchase_orders" ADD COLUMN     "freightAddedAt" TIMESTAMP(3),
ADD COLUMN     "freightAddedById" TEXT,
ADD COLUMN     "freightCharges" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "inventory_transactions_vendorPurchaseOrderItemId_idx" ON "inventory_transactions"("vendorPurchaseOrderItemId");

-- AddForeignKey
ALTER TABLE "vendor_purchase_orders" ADD CONSTRAINT "vendor_purchase_orders_freightAddedById_fkey" FOREIGN KEY ("freightAddedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_vendorPurchaseOrderItemId_fkey" FOREIGN KEY ("vendorPurchaseOrderItemId") REFERENCES "vendor_purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
