-- Split RndConsumeReason's USED into TESTING / FORMULATION_TRIAL.
-- Postgres has no DROP VALUE for enums, so the type is recreated —
-- safe here because zero rows in rnd_store_transactions reference any
-- RndConsumeReason value yet (verified before writing this migration).
ALTER TYPE "RndConsumeReason" RENAME TO "RndConsumeReason_old";
CREATE TYPE "RndConsumeReason" AS ENUM ('TESTING', 'FORMULATION_TRIAL', 'WASTAGE', 'REJECTED');
ALTER TABLE "rnd_store_transactions" ALTER COLUMN "consumeReason" TYPE "RndConsumeReason" USING ("consumeReason"::text::"RndConsumeReason");
DROP TYPE "RndConsumeReason_old";

-- New optional detail fields — CONSUMED gets projectName/formulationRef/
-- batchNo, DISPATCHED gets brandName/courierDetails, both get an
-- explicit editable `date` separate from createdAt.
ALTER TABLE "rnd_store_transactions" ADD COLUMN "date" TIMESTAMP(3);
ALTER TABLE "rnd_store_transactions" ADD COLUMN "brandName" TEXT;
ALTER TABLE "rnd_store_transactions" ADD COLUMN "courierDetails" TEXT;
ALTER TABLE "rnd_store_transactions" ADD COLUMN "projectName" TEXT;
ALTER TABLE "rnd_store_transactions" ADD COLUMN "formulationRef" TEXT;
ALTER TABLE "rnd_store_transactions" ADD COLUMN "batchNo" TEXT;
