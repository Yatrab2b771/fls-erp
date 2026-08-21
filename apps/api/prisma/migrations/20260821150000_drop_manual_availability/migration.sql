-- DropForeignKey
ALTER TABLE "pre_inventory_requirements" DROP CONSTRAINT "pre_inventory_requirements_availableById_fkey";

-- AlterTable
ALTER TABLE "pre_inventory_requirements" DROP COLUMN "availableAt",
DROP COLUMN "availableById",
DROP COLUMN "availableQty";

