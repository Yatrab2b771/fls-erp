-- A material can be dispensed in several rounds (partial dispensing): each line remembers what was given in its round and the round's GRN.
ALTER TABLE "batch_dispensing_lines" ADD COLUMN "givenQty" DOUBLE PRECISION;
ALTER TABLE "batch_dispensing_lines" ADD COLUMN "grnNo" TEXT;
-- Lines made before rounds existed gave their whole quantity in one round.
UPDATE "batch_dispensing_lines" SET "givenQty" = "quantity";
