-- Merge GRN_DONE into MATERIAL_RECEIVED — both are Store-owned and sit
-- back-to-back in the pipeline with nothing between them. Remap any
-- existing row first so nothing is left pointing at a value about to
-- stop existing.
UPDATE "batches" SET "currentStageId" = 'MATERIAL_RECEIVED' WHERE "currentStageId" = 'GRN_DONE';
UPDATE "batch_stage_events" SET "fromStageId" = 'MATERIAL_RECEIVED' WHERE "fromStageId" = 'GRN_DONE';
UPDATE "batch_stage_events" SET "toStageId" = 'MATERIAL_RECEIVED' WHERE "toStageId" = 'GRN_DONE';

CREATE TYPE "BatchStageId_new" AS ENUM ('PO_RELEASE', 'MATERIAL_RECEIVED', 'BILL_UPDATES', 'INDENT_ISSUE', 'INCOMING_QC', 'DEBIT_NOTE_ISSUE', 'PRODUCTION_PLAN', 'DISPENSING', 'PRODUCTION_EXECUTION', 'QA_GATE_MFG', 'PACKAGING', 'QA_GATE_PACKAGING', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');

ALTER TABLE "batches" ALTER COLUMN "currentStageId" DROP DEFAULT;
ALTER TABLE "batches" ALTER COLUMN "currentStageId" TYPE "BatchStageId_new" USING ("currentStageId"::text::"BatchStageId_new");
ALTER TABLE "batches" ALTER COLUMN "currentStageId" SET DEFAULT 'PO_RELEASE';

ALTER TABLE "batch_stage_events" ALTER COLUMN "fromStageId" TYPE "BatchStageId_new" USING ("fromStageId"::text::"BatchStageId_new");
ALTER TABLE "batch_stage_events" ALTER COLUMN "toStageId" TYPE "BatchStageId_new" USING ("toStageId"::text::"BatchStageId_new");

DROP TYPE "BatchStageId";
ALTER TYPE "BatchStageId_new" RENAME TO "BatchStageId";
