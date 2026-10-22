-- Production hands the QA-approved packed goods over to the Day Store; only then are they the Day Store's finished goods.
ALTER TABLE "production_batches" ADD COLUMN "handedToStoreAt" TIMESTAMP(3);
-- Batches already at FG Store or beyond were with the Day Store already.
UPDATE "production_batches" SET "handedToStoreAt" = now() WHERE "currentStageId"::text IN ('FG_STORE', 'FG_QC_RELEASE', 'FG_HANDOVER', 'BILLING_EWAY_BILL', 'DISPATCH_PLAN');
