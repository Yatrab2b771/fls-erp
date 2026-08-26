-- CreateTable
CREATE TABLE "day_store_assignments" (
    "userId" TEXT NOT NULL,
    "dayStoreId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,

    CONSTRAINT "day_store_assignments_pkey" PRIMARY KEY ("userId","dayStoreId")
);

-- AddForeignKey
ALTER TABLE "day_store_assignments" ADD CONSTRAINT "day_store_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_store_assignments" ADD CONSTRAINT "day_store_assignments_dayStoreId_fkey" FOREIGN KEY ("dayStoreId") REFERENCES "day_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_store_assignments" ADD CONSTRAINT "day_store_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
