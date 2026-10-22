-- The transporters Dispatch ships with: the Transport name on a shipment is picked from this list. Empty here: each system fills its own.
CREATE TABLE "transporters" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "transporterId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transporters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transporters_name_key" ON "transporters"("name");
