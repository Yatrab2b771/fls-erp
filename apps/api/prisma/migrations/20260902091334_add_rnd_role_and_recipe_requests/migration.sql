-- CreateEnum
CREATE TYPE "RecipeRequestStatus" AS ENUM ('PENDING', 'ETA_GIVEN', 'READY');

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'RND';

-- CreateTable
CREATE TABLE "recipe_requests" (
    "id" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "brandName" TEXT,
    "bomNeeded" BOOLEAN NOT NULL,
    "rmNeeded" BOOLEAN NOT NULL,
    "bomFulfilledAt" TIMESTAMP(3),
    "rmFulfilledAt" TIMESTAMP(3),
    "status" "RecipeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "etaDate" TIMESTAMP(3),
    "etaNote" TEXT,
    "respondedById" TEXT,
    "respondedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "recipe_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recipe_requests_purchaseOrderItemId_idx" ON "recipe_requests"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "recipe_requests_status_idx" ON "recipe_requests"("status");

-- AddForeignKey
ALTER TABLE "recipe_requests" ADD CONSTRAINT "recipe_requests_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_requests" ADD CONSTRAINT "recipe_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_requests" ADD CONSTRAINT "recipe_requests_respondedById_fkey" FOREIGN KEY ("respondedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
