-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_code_key" ON "inventory_items"("code");
