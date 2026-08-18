-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "BatchStageId_new" AS ENUM ('PO_RELEASE', 'MATERIAL_RECEIVED', 'INDENT_ISSUE', 'DISPENSING', 'PRODUCTION_EXECUTION', 'QA_GATE_MFG', 'PACKAGING', 'QA_GATE_PACKAGING', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');
ALTER TABLE "batches" ALTER COLUMN "currentStageId" DROP DEFAULT;
ALTER TABLE "batches" ALTER COLUMN "currentStageId" TYPE "BatchStageId_new" USING ("currentStageId"::text::"BatchStageId_new");
ALTER TABLE "batch_stage_events" ALTER COLUMN "fromStageId" TYPE "BatchStageId_new" USING ("fromStageId"::text::"BatchStageId_new");
ALTER TABLE "batch_stage_events" ALTER COLUMN "toStageId" TYPE "BatchStageId_new" USING ("toStageId"::text::"BatchStageId_new");
ALTER TYPE "BatchStageId" RENAME TO "BatchStageId_old";
ALTER TYPE "BatchStageId_new" RENAME TO "BatchStageId";
DROP TYPE "BatchStageId_old";
ALTER TABLE "batches" ALTER COLUMN "currentStageId" SET DEFAULT 'PO_RELEASE';
COMMIT;

-- AlterTable
ALTER TABLE "batches" DROP COLUMN "incomingQcRemarks",
DROP COLUMN "incomingQcStatus";

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT';

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

