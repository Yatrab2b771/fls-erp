-- CreateEnum
CREATE TYPE "VendorPurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED');

-- CreateTable
CREATE TABLE "vendor_purchase_orders" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "eta" TIMESTAMP(3),
    "status" "VendorPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "vendor_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_purchase_order_items" (
    "id" TEXT NOT NULL,
    "vendorPurchaseOrderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "gstPct" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "vendor_purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_purchase_orders_poNumber_key" ON "vendor_purchase_orders"("poNumber");

-- AddForeignKey
ALTER TABLE "vendor_purchase_orders" ADD CONSTRAINT "vendor_purchase_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_purchase_orders" ADD CONSTRAINT "vendor_purchase_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_purchase_orders" ADD CONSTRAINT "vendor_purchase_orders_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_purchase_order_items" ADD CONSTRAINT "vendor_purchase_order_items_vendorPurchaseOrderId_fkey" FOREIGN KEY ("vendorPurchaseOrderId") REFERENCES "vendor_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_purchase_order_items" ADD CONSTRAINT "vendor_purchase_order_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_purchase_order_items" ADD CONSTRAINT "vendor_purchase_order_items_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
