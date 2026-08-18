/*
  Warnings:

  - You are about to drop the column `userId` on the `bom_plan_items` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "RmPlanStatus" AS ENUM ('DRAFT', 'CALCULATED');

-- DropForeignKey
ALTER TABLE "bom_plan_items" DROP CONSTRAINT "bom_plan_items_userId_fkey";

-- AlterTable
ALTER TABLE "bom_plan_items" DROP COLUMN "userId";

-- CreateTable
CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalServing" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "costPerKg" DOUBLE PRECISION NOT NULL,
    "gPerServing" DOUBLE PRECISION NOT NULL,
    "proteinPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rm_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dateFrom" TIMESTAMP(3),
    "dateTo" TIMESTAMP(3),
    "status" "RmPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "costingParams" JSONB NOT NULL,
    "resultSnapshot" JSONB,
    "calculatedAt" TIMESTAMP(3),

    CONSTRAINT "rm_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rm_plan_items" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "batchSizeKg" DOUBLE PRECISION NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rm_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_name_key" ON "recipes"("name");

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rm_plans" ADD CONSTRAINT "rm_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rm_plan_items" ADD CONSTRAINT "rm_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "rm_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rm_plan_items" ADD CONSTRAINT "rm_plan_items_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
