-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employeeId" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_employeeId_key" ON "users"("employeeId");

