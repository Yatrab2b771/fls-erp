-- Production confirms what the Day Store dispensed (material by material) before the batch goes to Line Clearance.
ALTER TYPE "BatchPrepStage" ADD VALUE 'RECEIVE';

ALTER TABLE "batch_dispensing_lines"
  ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "sentQty" DOUBLE PRECISION,
  ADD COLUMN "issueTxnId" TEXT,
  ADD COLUMN "receivedAt" TIMESTAMP(3),
  ADD COLUMN "receivedById" TEXT,
  ADD COLUMN "receiveNote" TEXT;
