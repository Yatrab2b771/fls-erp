-- CreateEnum
CREATE TYPE "InventoryRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ISSUED');

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "fulfillsRequestId" TEXT;

-- CreateTable
CREATE TABLE "inventory_requests" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "requestedQty" DOUBLE PRECISION NOT NULL,
    "purpose" "InventoryTxnType" NOT NULL,
    "neededBy" TIMESTAMP(3),
    "note" TEXT,
    "status" "InventoryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_requests_status_idx" ON "inventory_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_fulfillsRequestId_key" ON "inventory_transactions"("fulfillsRequestId");

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_fulfillsRequestId_fkey" FOREIGN KEY ("fulfillsRequestId") REFERENCES "inventory_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
