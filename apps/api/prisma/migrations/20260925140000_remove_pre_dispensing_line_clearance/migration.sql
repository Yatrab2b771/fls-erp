-- Removes the LINE_CLEARANCE stage from the Pre-Production pipeline —
-- per the client's own two BMR documents (BMR-1.docx / POWDER BMR.docx),
-- only one Line Clearance check actually belongs in this tier, right
-- after Dispensing and before a Production Batch can be created (section
-- 4.0, "Line Clearance for Bulk Manufacturing"). The pre-Dispensing
-- checklist (section 1.0) is dropped from the live pipeline — any run
-- previously parked there, and any historical stage-event referencing
-- it, has already been remapped to DISPENSING by a prior data migration
-- step run ahead of this one.
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so the enum is rebuilt:
-- create the new type, repoint every column at it, drop the old type.
CREATE TYPE "PreProductionStageId_new" AS ENUM ('MATERIAL_RECEIVED', 'INDENT_ISSUE', 'DISPENSING', 'SAMPLE_QC_APPROVAL');

ALTER TABLE "pre_productions"
  ALTER COLUMN "currentStageId" DROP DEFAULT,
  ALTER COLUMN "currentStageId" TYPE "PreProductionStageId_new" USING ("currentStageId"::text::"PreProductionStageId_new"),
  ALTER COLUMN "currentStageId" SET DEFAULT 'MATERIAL_RECEIVED';

ALTER TABLE "pre_production_stage_events"
  ALTER COLUMN "fromStageId" TYPE "PreProductionStageId_new" USING ("fromStageId"::text::"PreProductionStageId_new"),
  ALTER COLUMN "toStageId" TYPE "PreProductionStageId_new" USING ("toStageId"::text::"PreProductionStageId_new");

DROP TYPE "PreProductionStageId";
ALTER TYPE "PreProductionStageId_new" RENAME TO "PreProductionStageId";
