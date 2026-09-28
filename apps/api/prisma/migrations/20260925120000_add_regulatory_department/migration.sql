-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'REGULATORY';

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "planSentToProductionAt" TIMESTAMP(3),
ADD COLUMN     "regulatoryRemarks" TEXT,
ADD COLUMN     "regulatoryReviewedAt" TIMESTAMP(3),
ADD COLUMN     "regulatoryReviewedById" TEXT,
ADD COLUMN     "regulatoryStatus" TEXT;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_regulatoryReviewedById_fkey" FOREIGN KEY ("regulatoryReviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
