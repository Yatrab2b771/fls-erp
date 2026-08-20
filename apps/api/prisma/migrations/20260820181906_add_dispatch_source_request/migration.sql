-- AlterTable
ALTER TABLE "dispatch_transfers" ADD COLUMN     "sourceRequestId" TEXT;

-- CreateIndex
CREATE INDEX "dispatch_transfers_sourceRequestId_idx" ON "dispatch_transfers"("sourceRequestId");

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_sourceRequestId_fkey" FOREIGN KEY ("sourceRequestId") REFERENCES "inventory_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

