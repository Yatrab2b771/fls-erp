-- Customer returns (received by the Warehouse, decided by QA, reworked by Production, placed by Dispatch) and Accounts' credit notes.
CREATE TYPE "CustomerReturnStatus" AS ENUM ('WITH_QA', 'IN_REWORK', 'AWAITING_DISPATCH', 'STORED', 'TO_BE_RESENT', 'SCRAPPED');

CREATE TABLE "customer_returns" (
  "id" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "returnedAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "condition" TEXT,
  "status" "CustomerReturnStatus" NOT NULL DEFAULT 'WITH_QA',
  "receivedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "qaDecision" TEXT,
  "qaNote" TEXT,
  "qaDecidedAt" TIMESTAMP(3),
  "qaDecidedById" TEXT,
  "passedQty" DOUBLE PRECISION,
  "scrapQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reworkNote" TEXT,
  "reworkedQty" DOUBLE PRECISION,
  "reworkDoneAt" TIMESTAMP(3),
  "reworkDoneById" TEXT,
  "dispatchChoice" TEXT,
  "dispatchNote" TEXT,
  "dispatchDecidedAt" TIMESTAMP(3),
  "dispatchDecidedById" TEXT,
  CONSTRAINT "customer_returns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_returns_productionBatchId_idx" ON "customer_returns"("productionBatchId");
CREATE INDEX "customer_returns_status_idx" ON "customer_returns"("status");
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "credit_notes" (
  "id" TEXT NOT NULL,
  "customerReturnId" TEXT NOT NULL,
  "creditNoteNo" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "amount" DOUBLE PRECISION,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_notes_customerReturnId_key" ON "credit_notes"("customerReturnId");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customerReturnId_fkey" FOREIGN KEY ("customerReturnId") REFERENCES "customer_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
