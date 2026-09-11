-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('EXISTING', 'NEW');

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "productType" "ProductType" NOT NULL DEFAULT 'EXISTING';
