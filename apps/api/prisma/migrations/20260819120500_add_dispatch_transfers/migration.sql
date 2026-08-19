-- CreateEnum
CREATE TYPE "DispatchTransferType" AS ENUM ('FG', 'BILL');

-- CreateTable
CREATE TABLE "dispatch_transfers" (
    "id" TEXT NOT NULL,
    "type" "DispatchTransferType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_transfers_customerId_idx" ON "dispatch_transfers"("customerId");

-- CreateIndex
CREATE INDEX "dispatch_transfers_type_date_idx" ON "dispatch_transfers"("type", "date");

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
