-- Production's "extra material" requests: material asked for outside any plan, from the Plant's own Day Store.
ALTER TABLE "inventory_requests" ADD COLUMN "isExtra" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "inventory_requests" ADD COLUMN "extraForPoItemId" TEXT;
