-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveredById" TEXT,
ADD COLUMN     "isTransitTracked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "inventory_transactions_isTransitTracked_deliveredAt_idx" ON "inventory_transactions"("isTransitTracked", "deliveredAt");

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
