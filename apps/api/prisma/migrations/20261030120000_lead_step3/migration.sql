-- Lead management step 3: estimated order size and conversion on a lead, and the BOM-uploaded mark on a sample request.
ALTER TABLE "leads" ADD COLUMN "estimatedQty" TEXT,
  ADD COLUMN "estimatedValueLac" DOUBLE PRECISION,
  ADD COLUMN "convertedAt" TIMESTAMP(3);

ALTER TABLE "sample_requests" ADD COLUMN "bomUploadedAt" TIMESTAMP(3);
