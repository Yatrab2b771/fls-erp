-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "coaAnalyzedAt" TIMESTAMP(3),
ADD COLUMN     "coaAnalyzedById" TEXT,
ADD COLUMN     "coaApprovedAt" TIMESTAMP(3),
ADD COLUMN     "coaApprovedById" TEXT,
ADD COLUMN     "coaRemark" TEXT,
ADD COLUMN     "coaResult" TEXT,
ADD COLUMN     "coaReviewedAt" TIMESTAMP(3),
ADD COLUMN     "coaReviewedById" TEXT;

-- CreateTable
CREATE TABLE "batch_coa_test_results" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "specification" TEXT,
    "observation" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "batch_coa_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_coa_test_results_batchId_idx" ON "batch_coa_test_results"("batchId");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_coaAnalyzedById_fkey" FOREIGN KEY ("coaAnalyzedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_coaReviewedById_fkey" FOREIGN KEY ("coaReviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_coaApprovedById_fkey" FOREIGN KEY ("coaApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_coa_test_results" ADD CONSTRAINT "batch_coa_test_results_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
