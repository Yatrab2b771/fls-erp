/*
  Warnings:

  - You are about to drop the column `mpsCycleId` on the `batches` table. All the data in the column will be lost.
  - You are about to drop the `batch_milestones` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `inventory_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `mps_cycles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `mps_step_events` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "BatchStageId" AS ENUM ('PO_RELEASE', 'MATERIAL_RECEIVED', 'GRN_DONE', 'BILL_UPDATES', 'INDENT_ISSUE', 'INCOMING_QC', 'DEBIT_NOTE_ISSUE', 'PRODUCTION_PLAN', 'DISPENSING', 'PRODUCTION_EXECUTION', 'TRANSFER_NOTE', 'QA_GATE_MFG', 'PACKAGING', 'QA_GATE_PACKAGING', 'FG_READY', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');

-- CreateEnum
CREATE TYPE "BatchStageAction" AS ENUM ('FORWARD', 'REJECT');

-- DropForeignKey
ALTER TABLE "batch_milestones" DROP CONSTRAINT "batch_milestones_batchId_fkey";

-- DropForeignKey
ALTER TABLE "batch_milestones" DROP CONSTRAINT "batch_milestones_completedById_fkey";

-- DropForeignKey
ALTER TABLE "batches" DROP CONSTRAINT "batches_mpsCycleId_fkey";

-- DropForeignKey
ALTER TABLE "mps_cycles" DROP CONSTRAINT "mps_cycles_createdById_fkey";

-- DropForeignKey
ALTER TABLE "mps_step_events" DROP CONSTRAINT "mps_step_events_actorId_fkey";

-- DropForeignKey
ALTER TABLE "mps_step_events" DROP CONSTRAINT "mps_step_events_cycleId_fkey";

-- AlterTable
ALTER TABLE "batches" DROP COLUMN "mpsCycleId",
ADD COLUMN     "currentStageId" "BatchStageId" NOT NULL DEFAULT 'PO_RELEASE';

-- DropTable
DROP TABLE "batch_milestones";

-- DropTable
DROP TABLE "inventory_items";

-- DropTable
DROP TABLE "mps_cycles";

-- DropTable
DROP TABLE "mps_step_events";

-- DropEnum
DROP TYPE "BatchMilestoneStatus";

-- DropEnum
DROP TYPE "BatchMilestoneType";

-- DropEnum
DROP TYPE "MpsCycleStatus";

-- DropEnum
DROP TYPE "MpsStepId";

-- CreateTable
CREATE TABLE "batch_stage_events" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fromStageId" "BatchStageId" NOT NULL,
    "toStageId" "BatchStageId" NOT NULL,
    "action" "BatchStageAction" NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_stage_events_batchId_idx" ON "batch_stage_events"("batchId");

-- AddForeignKey
ALTER TABLE "batch_stage_events" ADD CONSTRAINT "batch_stage_events_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_stage_events" ADD CONSTRAINT "batch_stage_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
