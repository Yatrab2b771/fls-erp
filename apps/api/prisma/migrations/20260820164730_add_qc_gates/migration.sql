-- CreateEnum
CREATE TYPE "InventoryReceiptStatus" AS ENUM ('PENDING_QC', 'QC_APPROVED', 'QC_REJECTED', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "DispatchQcStatus" AS ENUM ('PENDING_QC', 'QC_APPROVED', 'QC_REJECTED');

-- AlterTable
ALTER TABLE "dispatch_transfers" ADD COLUMN     "qcCheckedAt" TIMESTAMP(3),
ADD COLUMN     "qcCheckedById" TEXT,
ADD COLUMN     "qcNote" TEXT,
ADD COLUMN     "qcStatus" "DispatchQcStatus";

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedById" TEXT,
ADD COLUMN     "qcCheckedAt" TIMESTAMP(3),
ADD COLUMN     "qcCheckedById" TEXT,
ADD COLUMN     "qcNote" TEXT,
ADD COLUMN     "receiptStatus" "InventoryReceiptStatus";

-- CreateIndex
CREATE INDEX "dispatch_transfers_qcStatus_idx" ON "dispatch_transfers"("qcStatus");

-- CreateIndex
CREATE INDEX "inventory_transactions_receiptStatus_idx" ON "inventory_transactions"("receiptStatus");

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_qcCheckedById_fkey" FOREIGN KEY ("qcCheckedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_qcCheckedById_fkey" FOREIGN KEY ("qcCheckedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: existing rows predate this gate and were already treated as
-- final under the old rules — grandfather them in rather than silently
-- dropping them from the stock total / leaving old FG transfers stuck
-- showing "pending QC" for a shipment that already went out.
UPDATE "inventory_transactions" SET "receiptStatus" = 'ACCEPTED' WHERE "type" = 'RECEIVED';
UPDATE "dispatch_transfers" SET "qcStatus" = 'QC_APPROVED' WHERE "type" = 'FG';
