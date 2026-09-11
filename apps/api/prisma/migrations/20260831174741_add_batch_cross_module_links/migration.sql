-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "dispatchTransferId" TEXT,
ADD COLUMN     "sourceReceiptId" TEXT;

-- AlterTable
ALTER TABLE "inventory_requests" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "batches_sourceReceiptId_idx" ON "batches"("sourceReceiptId");

-- CreateIndex
CREATE INDEX "batches_dispatchTransferId_idx" ON "batches"("dispatchTransferId");

-- CreateIndex
CREATE INDEX "inventory_requests_batchId_idx" ON "inventory_requests"("batchId");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_sourceReceiptId_fkey" FOREIGN KEY ("sourceReceiptId") REFERENCES "inventory_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_dispatchTransferId_fkey" FOREIGN KEY ("dispatchTransferId") REFERENCES "dispatch_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
