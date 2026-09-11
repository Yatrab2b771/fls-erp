-- CreateEnum
CREATE TYPE "RndSampleRequestStatus" AS ENUM ('PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "rnd_sample_requests" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "status" "RndSampleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "transferId" TEXT,

    CONSTRAINT "rnd_sample_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rnd_sample_requests_transferId_key" ON "rnd_sample_requests"("transferId");

-- CreateIndex
CREATE INDEX "rnd_sample_requests_itemId_idx" ON "rnd_sample_requests"("itemId");

-- CreateIndex
CREATE INDEX "rnd_sample_requests_status_idx" ON "rnd_sample_requests"("status");

-- AddForeignKey
ALTER TABLE "rnd_sample_requests" ADD CONSTRAINT "rnd_sample_requests_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_sample_requests" ADD CONSTRAINT "rnd_sample_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_sample_requests" ADD CONSTRAINT "rnd_sample_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rnd_sample_requests" ADD CONSTRAINT "rnd_sample_requests_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "rnd_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
