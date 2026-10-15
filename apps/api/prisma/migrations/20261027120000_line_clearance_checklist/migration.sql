-- QA's BMR 4.0 Line Clearance checklist for a batch in the per-batch flow: { itemKey: true | false }.
ALTER TABLE "production_batches" ADD COLUMN "lineClearanceChecks" JSONB;
