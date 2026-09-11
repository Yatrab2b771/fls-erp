-- DropForeignKey
ALTER TABLE "skus" DROP CONSTRAINT "skus_brandId_fkey";

-- DropIndex
DROP INDEX "skus_brandId_productName_key";

-- AlterTable
ALTER TABLE "purchase_orders" DROP COLUMN "brandName";

-- AlterTable
ALTER TABLE "recipe_requests" DROP COLUMN "brandName",
ADD COLUMN     "customerName" TEXT;

-- AlterTable
ALTER TABLE "skus" DROP COLUMN "brandId",
ADD COLUMN     "customerId" TEXT NOT NULL;

-- DropTable
DROP TABLE "brands";

-- CreateIndex
CREATE UNIQUE INDEX "skus_customerId_productName_key" ON "skus"("customerId", "productName");

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
