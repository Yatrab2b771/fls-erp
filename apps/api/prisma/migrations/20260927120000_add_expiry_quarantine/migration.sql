-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "expiryReleasedAt" TIMESTAMP(3),
ADD COLUMN     "expiryReleasedById" TEXT;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_expiryReleasedById_fkey" FOREIGN KEY ("expiryReleasedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

