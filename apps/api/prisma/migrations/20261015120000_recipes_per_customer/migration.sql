-- A recipe now belongs to a customer (null = an older common recipe), so the same product can have a different recipe per customer.
ALTER TABLE "recipes" ADD COLUMN "customerId" TEXT;
DROP INDEX "recipes_name_key";
CREATE UNIQUE INDEX "recipes_customerId_name_key" ON "recipes"("customerId", "name");
CREATE INDEX "recipes_name_idx" ON "recipes"("name");
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
