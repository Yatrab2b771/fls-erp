-- Production's Hold on a batch that is still in preparation (before READY): who, when and why. Cleared on release.
ALTER TABLE "production_batches" ADD COLUMN "heldAt" TIMESTAMP(3);
ALTER TABLE "production_batches" ADD COLUMN "heldById" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "holdReason" TEXT;

ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_heldById_fkey" FOREIGN KEY ("heldById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
