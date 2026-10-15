-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "sentToRegulatoryAt" TIMESTAMP(3),
ADD COLUMN     "sentToRegulatoryById" TEXT;

-- Backfill: a product that already has a Regulatory decision, or already has a
-- calculated plan, counts as already sent — so existing data keeps showing up
-- in Regulatory's queue exactly as before.
UPDATE "purchase_order_items" i
SET "sentToRegulatoryAt" = COALESCE(i."regulatoryReviewedAt", NOW())
WHERE i."regulatoryStatus" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "bom_plans" b WHERE b."purchaseOrderItemId" = i."id" AND b."status" = 'CALCULATED')
   OR EXISTS (SELECT 1 FROM "rm_plans" r WHERE r."purchaseOrderItemId" = i."id" AND r."status" = 'CALCULATED');
