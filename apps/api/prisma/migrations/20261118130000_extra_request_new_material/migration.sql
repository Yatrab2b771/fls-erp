-- An extra request whose material Production typed in (it was not in the item list): flagged so the Store, Warehouse and PPIC see it is new.
ALTER TABLE "inventory_requests" ADD COLUMN "newMaterial" BOOLEAN NOT NULL DEFAULT false;
