-- Finished goods flow: a new batch stage (FG_HANDOVER) and the FG shipments Dispatch makes to the customer / the Warehouse.
ALTER TYPE "CombinedLotStageId" ADD VALUE 'FG_HANDOVER';

CREATE TYPE "FgShipmentType" AS ENUM ('CUSTOMER', 'WAREHOUSE');
CREATE TYPE "FgShipmentStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'SENT', 'RECEIVED', 'DISPATCHED');

CREATE TABLE "fg_shipments" (
    "id" TEXT NOT NULL,
    "productionBatchId" TEXT NOT NULL,
    "type" "FgShipmentType" NOT NULL,
    "status" "FgShipmentStatus" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "dispatchDate" TIMESTAMP(3),
    "transportType" TEXT,
    "pickedBy" TEXT,
    "pickingDate" TIMESTAMP(3),
    "loadedBy" TEXT,
    "loadingDate" TIMESTAMP(3),
    "remarks" TEXT,
    "invoiceNo" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "ewayBillNo" TEXT,
    "ewayBillDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "fg_shipments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fg_shipments_productionBatchId_idx" ON "fg_shipments"("productionBatchId");
CREATE INDEX "fg_shipments_type_status_idx" ON "fg_shipments"("type", "status");

ALTER TABLE "fg_shipments" ADD CONSTRAINT "fg_shipments_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fg_shipments" ADD CONSTRAINT "fg_shipments_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
