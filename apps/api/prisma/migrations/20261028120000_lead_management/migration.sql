-- Lead management (BD): leads, their meetings and moved follow-up dates.
CREATE TYPE "LeadStatus" AS ENUM ('DISCUSSION', 'SAMPLING', 'COLD', 'WARM', 'HOT', 'HOLD', 'DROPPED', 'CONVERTED');
CREATE TYPE "LeadMeetingMode" AS ENUM ('CALL', 'VIDEO', 'IN_PERSON');

CREATE TABLE "leads" (
  "id" TEXT NOT NULL,
  "brandName" TEXT NOT NULL,
  "contactPerson" TEXT NOT NULL DEFAULT '',
  "designation" TEXT NOT NULL DEFAULT '',
  "phones" TEXT[],
  "email" TEXT NOT NULL DEFAULT '',
  "address" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "state" TEXT NOT NULL DEFAULT '',
  "customerTypes" TEXT[],
  "productFormats" TEXT[],
  "powderTypes" TEXT[],
  "leadSource" TEXT,
  "status" "LeadStatus" NOT NULL DEFAULT 'DISCUSSION',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closureMonth" TEXT,
  "nextFollowUpAt" TIMESTAMP(3),
  "businessCardId" TEXT,
  "pocId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "leads_businessCardId_key" ON "leads"("businessCardId");
CREATE INDEX "leads_status_idx" ON "leads"("status");
CREATE INDEX "leads_pocId_idx" ON "leads"("pocId");
CREATE INDEX "leads_nextFollowUpAt_idx" ON "leads"("nextFollowUpAt");
ALTER TABLE "leads" ADD CONSTRAINT "leads_pocId_fkey" FOREIGN KEY ("pocId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_businessCardId_fkey" FOREIGN KEY ("businessCardId") REFERENCES "business_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "lead_meetings" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "meetingDate" TIMESTAMP(3) NOT NULL,
  "mode" "LeadMeetingMode" NOT NULL DEFAULT 'CALL',
  "notes" TEXT NOT NULL,
  "statusAfter" "LeadStatus" NOT NULL,
  "nextFollowUpAt" TIMESTAMP(3),
  "closureMonth" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_meetings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_meetings_leadId_number_key" ON "lead_meetings"("leadId", "number");
ALTER TABLE "lead_meetings" ADD CONSTRAINT "lead_meetings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_meetings" ADD CONSTRAINT "lead_meetings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "lead_reschedules" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "fromAt" TIMESTAMP(3),
  "toAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "byId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_reschedules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_reschedules_leadId_idx" ON "lead_reschedules"("leadId");
ALTER TABLE "lead_reschedules" ADD CONSTRAINT "lead_reschedules_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_reschedules" ADD CONSTRAINT "lead_reschedules_byId_fkey" FOREIGN KEY ("byId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
