-- Sample Request v2: the Sample Request Sheet's yellow (Sales), blue (R&D) and pink (RA) parts on one record, rounds, and the link from a lead.
ALTER TYPE "SampleRequestStatus" ADD VALUE IF NOT EXISTS 'PLANNING';
ALTER TYPE "SampleRequestStatus" ADD VALUE IF NOT EXISTS 'CANNOT_MAKE';

CREATE TYPE "SampleTemplate" AS ENUM ('POWDER', 'GUMMIES', 'BARS');
CREATE TYPE "SampleFeedback" AS ENUM ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED');

ALTER TABLE "sample_requests" ADD COLUMN "leadId" TEXT,
  ADD COLUMN "template" "SampleTemplate" NOT NULL DEFAULT 'POWDER',
  ADD COLUMN "composition" TEXT,
  ADD COLUMN "dosageForm" TEXT,
  ADD COLUMN "referenceSample" TEXT,
  ADD COLUMN "exportDomestic" TEXT,
  ADD COLUMN "labelClaim" TEXT,
  ADD COLUMN "expectedDate" TIMESTAMP(3),
  ADD COLUMN "preparedByName" TEXT,
  ADD COLUMN "preparedOn" TIMESTAMP(3),
  ADD COLUMN "rdRemarks" TEXT,
  ADD COLUMN "internalRemark" TEXT,
  ADD COLUMN "feedback" "SampleFeedback",
  ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "dispatchedAt" TIMESTAMP(3);
CREATE INDEX "sample_requests_leadId_idx" ON "sample_requests"("leadId");
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "sample_rounds" (
  "id" TEXT NOT NULL,
  "sampleRequestId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "sampleCode" TEXT,
  "preparedByName" TEXT,
  "expectedDate" TIMESTAMP(3),
  "preparedOn" TIMESTAMP(3),
  "rdRemarks" TEXT,
  "readyAt" TIMESTAMP(3),
  "dispatchedAt" TIMESTAMP(3),
  "feedback" "SampleFeedback" NOT NULL,
  "customerRemark" TEXT NOT NULL,
  "internalRemark" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sample_rounds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sample_rounds_sampleRequestId_round_key" ON "sample_rounds"("sampleRequestId", "round");
ALTER TABLE "sample_rounds" ADD CONSTRAINT "sample_rounds_sampleRequestId_fkey" FOREIGN KEY ("sampleRequestId") REFERENCES "sample_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rnd_sample_requests" ADD COLUMN "sampleRequestId" TEXT;
CREATE INDEX "rnd_sample_requests_sampleRequestId_idx" ON "rnd_sample_requests"("sampleRequestId");
ALTER TABLE "rnd_sample_requests" ADD CONSTRAINT "rnd_sample_requests_sampleRequestId_fkey" FOREIGN KEY ("sampleRequestId") REFERENCES "sample_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leads" ADD COLUMN "customerId" TEXT;
ALTER TABLE "leads" ADD CONSTRAINT "leads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
