-- Visiting cards for every department at an event: the event a card was collected at, scans read in the background (READING), and a
-- "possible duplicate of" link to the earlier card with the same email or phone.
ALTER TYPE "BusinessCardStatus" ADD VALUE IF NOT EXISTS 'READING';

ALTER TABLE "business_cards" ADD COLUMN "event" TEXT NOT NULL DEFAULT '',
ADD COLUMN "readError" TEXT,
ADD COLUMN "duplicateOfId" TEXT;

CREATE INDEX "business_cards_event_idx" ON "business_cards"("event");

ALTER TABLE "business_cards" ADD CONSTRAINT "business_cards_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "business_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
