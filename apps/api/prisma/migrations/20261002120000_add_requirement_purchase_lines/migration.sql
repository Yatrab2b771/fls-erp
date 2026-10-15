-- Purchase can split a shortfall into several PI / Vendor / ETA lines.
CREATE TYPE "PurchaseLineStatus" AS ENUM ('OPEN', 'RECEIVED');

CREATE TABLE "requirement_purchase_lines" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "piNumber" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "eta" TIMESTAMP(3) NOT NULL,
    "status" "PurchaseLineStatus" NOT NULL DEFAULT 'OPEN',
    "loggedById" TEXT NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correctedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirement_purchase_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "requirement_purchase_lines_requirementId_idx" ON "requirement_purchase_lines"("requirementId");
CREATE INDEX "requirement_purchase_lines_status_eta_idx" ON "requirement_purchase_lines"("status", "eta");

ALTER TABLE "requirement_purchase_lines" ADD CONSTRAINT "requirement_purchase_lines_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "pre_inventory_requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_purchase_lines" ADD CONSTRAINT "requirement_purchase_lines_loggedById_fkey" FOREIGN KEY ("loggedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every requirement that already has a PI logged becomes one line for its whole quantity.
INSERT INTO "requirement_purchase_lines" ("id", "requirementId", "quantity", "piNumber", "vendorName", "eta", "loggedById", "loggedAt", "correctedAt", "updatedAt")
SELECT md5(r."id" || ':line')::uuid::text, r."id", r."requiredQty", r."poNumber", COALESCE(r."vendorName", ''), COALESCE(r."eta", r."purchaseAt"), r."purchaseById", COALESCE(r."purchaseAt", CURRENT_TIMESTAMP), r."purchaseCorrectedAt", CURRENT_TIMESTAMP
FROM "pre_inventory_requirements" r
WHERE r."poNumber" IS NOT NULL AND r."purchaseAt" IS NOT NULL AND r."purchaseById" IS NOT NULL AND r."deletedAt" IS NULL;
