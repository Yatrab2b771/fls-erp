/*
  Warnings:

  - You are about to drop the column `batchId` on the `batch_coa_test_results` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `batch_material_consumptions` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `batch_recycle_logs` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `inventory_requests` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `inventory_transactions` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `qc_sample_transactions` table. All the data in the column will be lost.
  - You are about to drop the column `batchId` on the `qc_sample_transfers` table. All the data in the column will be lost.
  - You are about to drop the `batch_checklist_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `batch_stage_events` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `batches` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `combinedLotId` to the `batch_coa_test_results` table without a default value. This is not possible if the table is not empty.
  - Added the required column `preProductionId` to the `batch_material_consumptions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `combinedLotId` to the `batch_recycle_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `preProductionId` to the `qc_sample_transactions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `preProductionId` to the `qc_sample_transfers` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PreProductionStageId" AS ENUM ('MATERIAL_RECEIVED', 'INDENT_ISSUE', 'LINE_CLEARANCE', 'DISPENSING', 'SAMPLE_QC_APPROVAL');

-- CreateEnum
CREATE TYPE "ProductionBatchStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CombinedLotStageId" AS ENUM ('IPQC', 'QA_GATE_MFG', 'BULK_QC', 'PACKAGING', 'QA_GATE_PACKAGING', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');

-- DropForeignKey
ALTER TABLE "batch_checklist_items" DROP CONSTRAINT "batch_checklist_items_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batch_coa_test_results" DROP CONSTRAINT "batch_coa_test_results_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batch_material_consumptions" DROP CONSTRAINT "batch_material_consumptions_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batch_recycle_logs" DROP CONSTRAINT "batch_recycle_logs_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batch_stage_events" DROP CONSTRAINT "batch_stage_events_actorId_fkey";

-- DropForeignKey
ALTER TABLE "batch_stage_events" DROP CONSTRAINT "batch_stage_events_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_coaAnalyzedById_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_coaApprovedById_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_coaReviewedById_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_dispatchTransferId_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_plantId_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_purchaseOrderItemId_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_sourceReceiptId_fkey";

-- DropForeignKey
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_batchId_fkey";

-- DropForeignKey
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_batchId_fkey";

-- DropForeignKey
ALTER TABLE "qc_sample_transactions" DROP CONSTRAINT "qc_sample_transactions_batchId_fkey";

-- DropForeignKey
ALTER TABLE "qc_sample_transfers" DROP CONSTRAINT "qc_sample_transfers_batchId_fkey";

-- DropIndex
DROP INDEX "batch_coa_test_results_batchId_idx";

-- DropIndex
DROP INDEX "batch_material_consumptions_batchId_idx";

-- DropIndex
DROP INDEX "batch_recycle_logs_batchId_idx";

-- DropIndex
DROP INDEX "inventory_requests_batchId_idx";

-- DropIndex
DROP INDEX "inventory_transactions_batchId_idx";

-- DropIndex
DROP INDEX "qc_sample_transactions_batchId_idx";

-- DropIndex
DROP INDEX "qc_sample_transfers_batchId_idx";

-- AlterTable
ALTER TABLE "batch_coa_test_results" DROP COLUMN "batchId",
ADD COLUMN     "combinedLotId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "batch_material_consumptions" DROP COLUMN "batchId",
ADD COLUMN     "preProductionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "batch_recycle_logs" DROP COLUMN "batchId",
ADD COLUMN     "combinedLotId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "inventory_requests" DROP COLUMN "batchId",
ADD COLUMN     "preProductionId" TEXT;

-- AlterTable
ALTER TABLE "inventory_transactions" DROP COLUMN "batchId",
ADD COLUMN     "preProductionId" TEXT;

-- AlterTable
ALTER TABLE "qc_sample_transactions" DROP COLUMN "batchId",
ADD COLUMN     "preProductionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "qc_sample_transfers" DROP COLUMN "batchId",
ADD COLUMN     "preProductionId" TEXT NOT NULL;

-- DropTable
DROP TABLE "batch_checklist_items";

-- DropTable
DROP TABLE "batch_stage_events";

-- DropTable
DROP TABLE "batches";

-- DropEnum
DROP TYPE "BatchChecklistType";

-- DropEnum
DROP TYPE "BatchStageId";

-- CreateTable
CREATE TABLE "pre_productions" (
    "id" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "currentStageId" "PreProductionStageId" NOT NULL DEFAULT 'MATERIAL_RECEIVED',
    "plannedQty" DOUBLE PRECISION NOT NULL,
    "combinedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "plantId" TEXT,
    "grnNo" TEXT,
    "grnDate" TIMESTAMP(3),
    "materialReceivedRemarks" TEXT,
    "sourceReceiptId" TEXT,
    "prodIndentSlipSign" TEXT,
    "productionPlanDate" TIMESTAMP(3),
    "unit" TEXT,
    "dispatchPlanDate" TIMESTAMP(3),
    "lineClearanceStatus" TEXT,
    "lineClearanceRemarks" TEXT,
    "rmDispensingDate" TIMESTAMP(3),
    "rmDispensingRemarks" TEXT,
    "pmIssuedDate" TIMESTAMP(3),
    "pmDispensingRemarks" TEXT,
    "sampleQcStatus" TEXT,
    "sampleQcRemarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_productions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_batches" (
    "id" TEXT NOT NULL,
    "preProductionId" TEXT NOT NULL,
    "batchNo" TEXT,
    "plannedQty" DOUBLE PRECISION NOT NULL,
    "status" "ProductionBatchStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "manufacturingStartDate" TIMESTAMP(3),
    "manufacturingStatus" TEXT,
    "manufacturingEndDate" TIMESTAMP(3),
    "manufacturingRemarks" TEXT,
    "inputQty" DOUBLE PRECISION,
    "outputQty" DOUBLE PRECISION,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combined_lots" (
    "id" TEXT NOT NULL,
    "preProductionId" TEXT NOT NULL,
    "currentStageId" "CombinedLotStageId" NOT NULL DEFAULT 'IPQC',
    "bulkTheoreticalWeight" DOUBLE PRECISION,
    "bulkActualWeight" DOUBLE PRECISION,
    "bulkQcSampleWeight" DOUBLE PRECISION,
    "bulkTransferToPackingQty" DOUBLE PRECISION,
    "ipqcStatus" TEXT,
    "ipqcRemarks" TEXT,
    "mfgQaStatus" TEXT,
    "mfgQcStatus" TEXT,
    "mfgRemarks" TEXT,
    "mfgApprovedQty" DOUBLE PRECISION,
    "mfgRejectedQty" DOUBLE PRECISION,
    "mfgWastageQty" DOUBLE PRECISION,
    "bulkQcStatus" TEXT,
    "bulkQcRemarks" TEXT,
    "coaResult" TEXT,
    "coaRemark" TEXT,
    "coaAnalyzedById" TEXT,
    "coaAnalyzedAt" TIMESTAMP(3),
    "coaReviewedById" TEXT,
    "coaReviewedAt" TIMESTAMP(3),
    "coaApprovedById" TEXT,
    "coaApprovedAt" TIMESTAMP(3),
    "packagingStartDate" TIMESTAMP(3),
    "packagingStatus" TEXT,
    "packagingEndDate" TIMESTAMP(3),
    "packagingRemarks" TEXT,
    "packQaStatus" TEXT,
    "packQcStatus" TEXT,
    "packRemarks" TEXT,
    "packApprovedQty" DOUBLE PRECISION,
    "packRejectedQty" DOUBLE PRECISION,
    "packWastageQty" DOUBLE PRECISION,
    "invoiceNo" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "ewayBillNo" TEXT,
    "ewayBillDate" TIMESTAMP(3),
    "billingRemarks" TEXT,
    "dispatchDate" TIMESTAMP(3),
    "dispatchedQty" DOUBLE PRECISION,
    "shipperQty" DOUBLE PRECISION,
    "totalShipperWeight" DOUBLE PRECISION,
    "transportType" TEXT,
    "remainingQty" DOUBLE PRECISION,
    "anyRemarks" TEXT,
    "dispatchTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "combined_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_production_checklist_items" (
    "id" TEXT NOT NULL,
    "preProductionId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "deptOk" BOOLEAN,
    "qaOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_production_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combined_lot_checklist_items" (
    "id" TEXT NOT NULL,
    "combinedLotId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "deptOk" BOOLEAN,
    "qaOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "combined_lot_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_production_stage_events" (
    "id" TEXT NOT NULL,
    "preProductionId" TEXT NOT NULL,
    "fromStageId" "PreProductionStageId" NOT NULL,
    "toStageId" "PreProductionStageId" NOT NULL,
    "action" "BatchStageAction" NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_production_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combined_lot_stage_events" (
    "id" TEXT NOT NULL,
    "combinedLotId" TEXT NOT NULL,
    "fromStageId" "CombinedLotStageId" NOT NULL,
    "toStageId" "CombinedLotStageId" NOT NULL,
    "action" "BatchStageAction" NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combined_lot_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pre_productions_purchaseOrderItemId_key" ON "pre_productions"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "pre_productions_plantId_idx" ON "pre_productions"("plantId");

-- CreateIndex
CREATE INDEX "pre_productions_sourceReceiptId_idx" ON "pre_productions"("sourceReceiptId");

-- CreateIndex
CREATE INDEX "production_batches_preProductionId_idx" ON "production_batches"("preProductionId");

-- CreateIndex
CREATE UNIQUE INDEX "combined_lots_preProductionId_key" ON "combined_lots"("preProductionId");

-- CreateIndex
CREATE INDEX "combined_lots_dispatchTransferId_idx" ON "combined_lots"("dispatchTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_production_checklist_items_preProductionId_itemKey_key" ON "pre_production_checklist_items"("preProductionId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "combined_lot_checklist_items_combinedLotId_itemKey_key" ON "combined_lot_checklist_items"("combinedLotId", "itemKey");

-- CreateIndex
CREATE INDEX "pre_production_stage_events_preProductionId_idx" ON "pre_production_stage_events"("preProductionId");

-- CreateIndex
CREATE INDEX "combined_lot_stage_events_combinedLotId_idx" ON "combined_lot_stage_events"("combinedLotId");

-- CreateIndex
CREATE INDEX "batch_coa_test_results_combinedLotId_idx" ON "batch_coa_test_results"("combinedLotId");

-- CreateIndex
CREATE INDEX "batch_material_consumptions_preProductionId_idx" ON "batch_material_consumptions"("preProductionId");

-- CreateIndex
CREATE INDEX "batch_recycle_logs_combinedLotId_idx" ON "batch_recycle_logs"("combinedLotId");

-- CreateIndex
CREATE INDEX "inventory_requests_preProductionId_idx" ON "inventory_requests"("preProductionId");

-- CreateIndex
CREATE INDEX "inventory_transactions_preProductionId_idx" ON "inventory_transactions"("preProductionId");

-- CreateIndex
CREATE INDEX "qc_sample_transactions_preProductionId_idx" ON "qc_sample_transactions"("preProductionId");

-- CreateIndex
CREATE INDEX "qc_sample_transfers_preProductionId_idx" ON "qc_sample_transfers"("preProductionId");

-- AddForeignKey
ALTER TABLE "pre_productions" ADD CONSTRAINT "pre_productions_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_productions" ADD CONSTRAINT "pre_productions_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_productions" ADD CONSTRAINT "pre_productions_sourceReceiptId_fkey" FOREIGN KEY ("sourceReceiptId") REFERENCES "inventory_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lots" ADD CONSTRAINT "combined_lots_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lots" ADD CONSTRAINT "combined_lots_dispatchTransferId_fkey" FOREIGN KEY ("dispatchTransferId") REFERENCES "dispatch_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lots" ADD CONSTRAINT "combined_lots_coaAnalyzedById_fkey" FOREIGN KEY ("coaAnalyzedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lots" ADD CONSTRAINT "combined_lots_coaReviewedById_fkey" FOREIGN KEY ("coaReviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lots" ADD CONSTRAINT "combined_lots_coaApprovedById_fkey" FOREIGN KEY ("coaApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transfers" ADD CONSTRAINT "qc_sample_transfers_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_sample_transactions" ADD CONSTRAINT "qc_sample_transactions_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_recycle_logs" ADD CONSTRAINT "batch_recycle_logs_combinedLotId_fkey" FOREIGN KEY ("combinedLotId") REFERENCES "combined_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_production_checklist_items" ADD CONSTRAINT "pre_production_checklist_items_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lot_checklist_items" ADD CONSTRAINT "combined_lot_checklist_items_combinedLotId_fkey" FOREIGN KEY ("combinedLotId") REFERENCES "combined_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_coa_test_results" ADD CONSTRAINT "batch_coa_test_results_combinedLotId_fkey" FOREIGN KEY ("combinedLotId") REFERENCES "combined_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_production_stage_events" ADD CONSTRAINT "pre_production_stage_events_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_production_stage_events" ADD CONSTRAINT "pre_production_stage_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lot_stage_events" ADD CONSTRAINT "combined_lot_stage_events_combinedLotId_fkey" FOREIGN KEY ("combinedLotId") REFERENCES "combined_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combined_lot_stage_events" ADD CONSTRAINT "combined_lot_stage_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_preProductionId_fkey" FOREIGN KEY ("preProductionId") REFERENCES "pre_productions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
