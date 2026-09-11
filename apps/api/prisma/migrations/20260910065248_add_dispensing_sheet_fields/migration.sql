-- AlterTable
ALTER TABLE "batch_material_consumptions" ADD COLUMN     "arNo" TEXT,
ADD COLUMN     "grossWeight" DOUBLE PRECISION,
ADD COLUMN     "qaVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "qaVerifiedById" TEXT,
ADD COLUMN     "tareWeight" DOUBLE PRECISION;

-- AddForeignKey
ALTER TABLE "batch_material_consumptions" ADD CONSTRAINT "batch_material_consumptions_qaVerifiedById_fkey" FOREIGN KEY ("qaVerifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
