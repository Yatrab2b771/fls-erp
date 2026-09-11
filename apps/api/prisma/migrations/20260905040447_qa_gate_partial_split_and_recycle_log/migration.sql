-- CreateEnum
CREATE TYPE "QaGateStageId" AS ENUM ('QA_GATE_MFG', 'QA_GATE_PACKAGING');

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "mfgApprovedQty" DOUBLE PRECISION,
ADD COLUMN     "mfgWastageQty" DOUBLE PRECISION,
ADD COLUMN     "packApprovedQty" DOUBLE PRECISION,
ADD COLUMN     "packRejectedQty" DOUBLE PRECISION,
ADD COLUMN     "packWastageQty" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "batch_recycle_logs" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "stageId" "QaGateStageId" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_recycle_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_recycle_logs_batchId_idx" ON "batch_recycle_logs"("batchId");

-- AddForeignKey
ALTER TABLE "batch_recycle_logs" ADD CONSTRAINT "batch_recycle_logs_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_recycle_logs" ADD CONSTRAINT "batch_recycle_logs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
