CREATE TYPE "FinanceStatus" AS ENUM ('PAID_PARTIAL', 'PAID_FULL', 'ON_HOLD', 'REJECTED');

CREATE TABLE "finance_decisions" (
  "id" TEXT NOT NULL,
  "purchaseLineId" TEXT NOT NULL,
  "status" "FinanceStatus" NOT NULL,
  "poAmount" DOUBLE PRECISION,
  "remarks" TEXT,
  "remarksAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "finance_decisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_decisions_purchaseLineId_key" ON "finance_decisions"("purchaseLineId");

CREATE TABLE "finance_payments" (
  "id" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "paidOn" TIMESTAMP(3) NOT NULL,
  "remark" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "finance_payments_decisionId_idx" ON "finance_payments"("decisionId");

ALTER TABLE "finance_decisions" ADD CONSTRAINT "finance_decisions_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "requirement_purchase_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance_decisions" ADD CONSTRAINT "finance_decisions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "finance_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
