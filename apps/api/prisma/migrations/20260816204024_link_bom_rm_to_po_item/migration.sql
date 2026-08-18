-- AlterTable
ALTER TABLE "bom_plans" ADD COLUMN     "purchaseOrderItemId" TEXT;

-- AlterTable
ALTER TABLE "rm_plans" ADD COLUMN     "purchaseOrderItemId" TEXT;

-- AddForeignKey
ALTER TABLE "bom_plans" ADD CONSTRAINT "bom_plans_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rm_plans" ADD CONSTRAINT "rm_plans_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
