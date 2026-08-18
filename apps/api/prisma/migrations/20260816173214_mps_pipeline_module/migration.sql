-- CreateEnum
CREATE TYPE "MpsStepId" AS ENUM ('S1', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S10_PROD', 'S11', 'S10C', 'S12', 'S13', 'END');

-- CreateEnum
CREATE TYPE "MpsCycleStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "mpsCycleId" TEXT;

-- CreateTable
CREATE TABLE "mps_cycles" (
    "id" TEXT NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "currentStepId" "MpsStepId" NOT NULL DEFAULT 'S1',
    "status" "MpsCycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "completedSubtaskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "materialRequirements" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mps_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mps_step_events" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "stepId" "MpsStepId" NOT NULL,
    "role" "RoleName",
    "action" TEXT NOT NULL,
    "log" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mps_step_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currentQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mps_step_events_cycleId_idx" ON "mps_step_events"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_code_key" ON "inventory_items"("code");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_mpsCycleId_fkey" FOREIGN KEY ("mpsCycleId") REFERENCES "mps_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mps_cycles" ADD CONSTRAINT "mps_cycles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mps_step_events" ADD CONSTRAINT "mps_step_events_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "mps_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mps_step_events" ADD CONSTRAINT "mps_step_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
