-- AlterTable
ALTER TABLE "bom_plans" ADD COLUMN     "sentToPreInventoryAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rm_plans" ADD COLUMN     "sentToPreInventoryAt" TIMESTAMP(3);
