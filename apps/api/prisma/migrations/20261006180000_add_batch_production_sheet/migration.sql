-- The production sheet of a batch: shift, manpower, and the full start / end date-time.
ALTER TABLE "production_batches" ADD COLUMN "shift" TEXT;
ALTER TABLE "production_batches" ADD COLUMN "manpowerCount" INTEGER;
ALTER TABLE "production_batches" ADD COLUMN "shiftStartAt" TIMESTAMP(3);
ALTER TABLE "production_batches" ADD COLUMN "shiftEndAt" TIMESTAMP(3);
