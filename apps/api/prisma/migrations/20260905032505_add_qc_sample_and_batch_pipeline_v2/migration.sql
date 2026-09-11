-- CreateEnum
CREATE TYPE "BatchConsumptionPurpose" AS ENUM ('PRODUCTION', 'SAMPLE', 'WASTE');

-- CreateEnum
CREATE TYPE "QcSampleDirection" AS ENUM ('TO_QC', 'TO_PLANT');

-- CreateEnum
CREATE TYPE "QcSampleConsumeReason" AS ENUM ('TESTING', 'WASTAGE', 'REJECTED');

-- CreateEnum
CREATE TYPE "QcSampleTxnType" AS ENUM ('INBOUND', 'CONSUMED', 'RETURNED');

-- AlterEnum
ALTER TYPE "BatchStageId" ADD VALUE 'SAMPLE_QC_APPROVAL';

-- AlterEnum
ALTER TYPE "InventoryTxnType" ADD VALUE 'ISSUED_RECYCLE';

-- AlterTable
ALTER TABLE "batch_material_consumptions" ADD COLUMN     "purpose" "BatchConsumptionPurpose" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "plannedQty" DOUBLE PRECISION,
ADD COLUMN     "sampleQcRemarks" TEXT,
ADD COLUMN     "sampleQcStatus" TEXT,
ALTER COLUMN "currentStageId" SET DEFAULT 'MATERIAL_RECEIVED';

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "qc_sample_transfers" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "direction" "QcSampleDirection" NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "qc_sample_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_sample_transactions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "QcSampleTxnType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "consumeReason" "QcSampleConsumeReason",
    "note" TEXT,
    "transferId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "qc_sample_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qc_sample_transfers_batchId_idx" ON "qc_sample_transfers"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "qc_sample_transactions_transferId_key" ON "qc_sample_transactions"("transferId");

-- CreateIndex
CREATE INDEX "qc_sample_transactions_batchId_idx" ON "qc_sample_transactions"("batchId");

-- CreateIndex
CREATE INDEX "qc_sample_transactions_itemId_idx" ON "qc_sample_transactions"("itemId");

-- CreateIndex
CREATE INDEX "inventory_transactions_batchId_idx" ON "inventory_transactions"("batchId");

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "qc_sample_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
