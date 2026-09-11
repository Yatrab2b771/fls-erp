-- CreateEnum
CREATE TYPE "RndTransferDirection" AS ENUM ('TO_RND', 'TO_WAREHOUSE');

-- CreateEnum
CREATE TYPE "RndStoreTxnType" AS ENUM ('INBOUND', 'CONSUMED', 'DISPATCHED', 'RETURNED');

-- CreateEnum
CREATE TYPE "RndConsumeReason" AS ENUM ('USED', 'WASTAGE', 'REJECTED');

-- AlterEnum
ALTER TYPE "InventoryTxnType" ADD VALUE 'ISSUED_RND';

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "isRndReturn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "rnd_transfers" (
    "id" TEXT NOT NULL,
    "direction" "RndTransferDirection" NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "rnd_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rnd_store_transactions" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "RndStoreTxnType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "consumeReason" "RndConsumeReason",
    "customerId" TEXT,
    "note" TEXT,
    "transferId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "rnd_store_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rnd_transfers_itemId_idx" ON "rnd_transfers"("itemId");

-- CreateIndex
CREATE INDEX "rnd_transfers_direction_confirmedAt_idx" ON "rnd_transfers"("direction", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "rnd_store_transactions_transferId_key" ON "rnd_store_transactions"("transferId");

-- CreateIndex
CREATE INDEX "rnd_store_transactions_itemId_idx" ON "rnd_store_transactions"("itemId");

-- CreateIndex
CREATE INDEX "rnd_store_transactions_type_idx" ON "rnd_store_transactions"("type");

-- AddForeignKey
ALTER TABLE "rnd_transfers" ADD CONSTRAINT "rnd_transfers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_transfers" ADD CONSTRAINT "rnd_transfers_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_transfers" ADD CONSTRAINT "rnd_transfers_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_transfers" ADD CONSTRAINT "rnd_transfers_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_store_transactions" ADD CONSTRAINT "rnd_store_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_store_transactions" ADD CONSTRAINT "rnd_store_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_store_transactions" ADD CONSTRAINT "rnd_store_transactions_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "rnd_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_store_transactions" ADD CONSTRAINT "rnd_store_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_store_transactions" ADD CONSTRAINT "rnd_store_transactions_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
