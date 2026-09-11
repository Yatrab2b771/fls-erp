/*
  Warnings:

  - You are about to drop the `batch_line_clearance_items` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "BatchChecklistType" AS ENUM ('LINE_CLEARANCE_DISPENSING', 'LINE_CLEARANCE_BULK_MFG');

-- DropForeignKey
ALTER TABLE "batch_line_clearance_items" DROP CONSTRAINT "batch_line_clearance_items_batchId_fkey";

-- DropTable
DROP TABLE "batch_line_clearance_items";

-- CreateTable
CREATE TABLE "batch_checklist_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "type" "BatchChecklistType" NOT NULL,
    "itemKey" TEXT NOT NULL,
    "deptOk" BOOLEAN,
    "qaOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "batch_checklist_items_batchId_type_itemKey_key" ON "batch_checklist_items"("batchId", "type", "itemKey");

-- AddForeignKey
ALTER TABLE "batch_checklist_items" ADD CONSTRAINT "batch_checklist_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
