CREATE TYPE "BusinessCardStatus" AS ENUM ('NEEDS_VERIFY', 'VERIFIED');
CREATE TABLE "business_cards" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "designation" TEXT NOT NULL DEFAULT '',
  "company" TEXT NOT NULL DEFAULT '',
  "phones" TEXT[],
  "email" TEXT NOT NULL DEFAULT '',
  "website" TEXT NOT NULL DEFAULT '',
  "address" TEXT NOT NULL DEFAULT '',
  "gstNo" TEXT NOT NULL DEFAULT '',
  "categories" TEXT[],
  "notes" TEXT NOT NULL DEFAULT '',
  "status" "BusinessCardStatus" NOT NULL DEFAULT 'NEEDS_VERIFY',
  "source" TEXT NOT NULL DEFAULT 'SCAN',
  "photoPath" TEXT,
  "photoMime" TEXT,
  "confidence" JSONB,
  "ocrLines" JSONB,
  "customerId" TEXT,
  "createdById" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_cards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "business_cards_createdById_status_idx" ON "business_cards"("createdById", "status");
CREATE INDEX "business_cards_company_idx" ON "business_cards"("company");
ALTER TABLE "business_cards" ADD CONSTRAINT "business_cards_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_cards" ADD CONSTRAINT "business_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
