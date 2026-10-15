-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "productCategory" TEXT;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_name_key" ON "product_categories"("name");

-- Seed the default dropdown options
INSERT INTO "product_categories" ("id", "name") VALUES
  (gen_random_uuid()::text, 'Powder'),
  (gen_random_uuid()::text, 'Gummies'),
  (gen_random_uuid()::text, 'Bars'),
  (gen_random_uuid()::text, 'Capsule'),
  (gen_random_uuid()::text, 'Tablet'),
  (gen_random_uuid()::text, 'Liquid');
