ALTER TABLE "inventory_transactions" ADD COLUMN "rate" DOUBLE PRECISION;
ALTER TABLE "inventory_transactions" ADD COLUMN "invoiceNo" TEXT;
ALTER TABLE "inventory_transactions" ADD COLUMN "invoiceDate" TIMESTAMP(3);
