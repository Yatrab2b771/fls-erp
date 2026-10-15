-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "cancelReason" TEXT;
