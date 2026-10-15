CREATE TYPE "SampleRequestStatus" AS ENUM ('REQUESTED', 'IN_PROCESS', 'READY', 'DISPATCHED', 'ON_HOLD');
CREATE TABLE "sample_requests" (
  "id" TEXT NOT NULL,
  "requestNo" SERIAL NOT NULL,
  "customerId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "quantity" TEXT,
  "neededBy" TIMESTAMP(3),
  "remarks" TEXT,
  "status" "SampleRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sampleCode" TEXT,
  "clientFeedback" TEXT,
  "requestedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sample_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sample_requests_requestNo_key" ON "sample_requests"("requestNo");
CREATE INDEX "sample_requests_status_idx" ON "sample_requests"("status");
CREATE INDEX "sample_requests_customerId_idx" ON "sample_requests"("customerId");
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
