-- Remove TRANSFER_NOTE and FG_READY from the pipeline. Any batch/event
-- currently sitting on one of these values is moved to the nearest
-- remaining stage first, so no row is left pointing at a value about to
-- stop existing.
UPDATE "batches" SET "currentStageId" = 'QA_GATE_MFG' WHERE "currentStageId" = 'TRANSFER_NOTE';
UPDATE "batches" SET "currentStageId" = 'BILLING_EWAY_BILL' WHERE "currentStageId" = 'FG_READY';
UPDATE "batch_stage_events" SET "fromStageId" = 'QA_GATE_MFG' WHERE "fromStageId" = 'TRANSFER_NOTE';
UPDATE "batch_stage_events" SET "toStageId" = 'QA_GATE_MFG' WHERE "toStageId" = 'TRANSFER_NOTE';
UPDATE "batch_stage_events" SET "fromStageId" = 'BILLING_EWAY_BILL' WHERE "fromStageId" = 'FG_READY';
UPDATE "batch_stage_events" SET "toStageId" = 'BILLING_EWAY_BILL' WHERE "toStageId" = 'FG_READY';

-- Recreate the enum without the two removed values (Postgres has no
-- direct DROP VALUE) and repoint every column that uses it.
CREATE TYPE "BatchStageId_new" AS ENUM ('PO_RELEASE', 'MATERIAL_RECEIVED', 'GRN_DONE', 'BILL_UPDATES', 'INDENT_ISSUE', 'INCOMING_QC', 'DEBIT_NOTE_ISSUE', 'PRODUCTION_PLAN', 'DISPENSING', 'PRODUCTION_EXECUTION', 'QA_GATE_MFG', 'PACKAGING', 'QA_GATE_PACKAGING', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');

ALTER TABLE "batches" ALTER COLUMN "currentStageId" DROP DEFAULT;
ALTER TABLE "batches" ALTER COLUMN "currentStageId" TYPE "BatchStageId_new" USING ("currentStageId"::text::"BatchStageId_new");
ALTER TABLE "batches" ALTER COLUMN "currentStageId" SET DEFAULT 'PO_RELEASE';

ALTER TABLE "batch_stage_events" ALTER COLUMN "fromStageId" TYPE "BatchStageId_new" USING ("fromStageId"::text::"BatchStageId_new");
ALTER TABLE "batch_stage_events" ALTER COLUMN "toStageId" TYPE "BatchStageId_new" USING ("toStageId"::text::"BatchStageId_new");

DROP TYPE "BatchStageId";
ALTER TYPE "BatchStageId_new" RENAME TO "BatchStageId";
