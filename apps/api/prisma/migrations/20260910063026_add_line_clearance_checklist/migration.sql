-- CreateTable
CREATE TABLE "batch_line_clearance_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "storeOk" BOOLEAN,
    "qaOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_line_clearance_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "batch_line_clearance_items_batchId_itemKey_key" ON "batch_line_clearance_items"("batchId", "itemKey");

-- AddForeignKey
ALTER TABLE "batch_line_clearance_items" ADD CONSTRAINT "batch_line_clearance_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
