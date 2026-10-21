-- Recycle Store: what was wastage and what was rejected, and QA's decisions on the rejected.
ALTER TABLE "inventory_transactions" ADD COLUMN "recycleKind" TEXT;
-- Entries already there: the Plant wrote "Rejected at the Plant ..." in the remark for the rejected ones; every other one is wastage.
UPDATE "inventory_transactions" SET "recycleKind" = CASE WHEN "remark" LIKE 'Rejected at the Plant%' THEN 'REJECTED' ELSE 'WASTAGE' END WHERE "type" = 'ISSUED_RECYCLE';

CREATE TABLE "recycle_decisions" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "note" TEXT,
  "certificateNo" TEXT,
  "stockAdjustmentId" TEXT,
  "decidedById" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recycle_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "recycle_decisions_transactionId_idx" ON "recycle_decisions"("transactionId");
ALTER TABLE "recycle_decisions" ADD CONSTRAINT "recycle_decisions_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "inventory_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
