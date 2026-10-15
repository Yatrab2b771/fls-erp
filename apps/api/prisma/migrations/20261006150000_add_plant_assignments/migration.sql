-- Limits a PRODUCTION user to specific Plants (the Production side of a Day Store login).
CREATE TABLE "plant_assignments" (
    "userId" TEXT NOT NULL,
    "plantId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,

    CONSTRAINT "plant_assignments_pkey" PRIMARY KEY ("userId","plantId")
);

ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
