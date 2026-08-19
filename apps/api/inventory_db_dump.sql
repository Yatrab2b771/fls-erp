--
-- Inventory module — schema-only reference dump
--
-- Reflects the current state of the Warehouse-level Inventory tables after
-- migrations 20260818100825_inventory_module, 20260819120000_inventory_
-- split_issued_by_destination, and 20260819120500_add_dispatch_transfers.
-- This is a hand-assembled reference (current shape, not a chronological
-- migration diff) for onboarding/handoff use — the Prisma migrations under
-- prisma/migrations/ remain the source of truth applied to real databases;
-- update this file alongside them, don't apply it directly.
--
-- Reconstructed from "Inventory tool.xlsx" — see the schema.prisma comment
-- above the InventoryCategory/InventoryTxnType/DispatchTransferType enums
-- for the sheet-to-schema mapping.
--

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------

CREATE TYPE "InventoryCategory" AS ENUM ('RM', 'PM');

-- RECEIVED = "MATERIAL RECEIVED" sheet.
-- ISSUED_DAY_STORE = "MATERIAL Issued to day store" sheet.
-- ISSUED_PRODUCTION = "MATERIAL Issued to Production" sheet.
CREATE TYPE "InventoryTxnType" AS ENUM ('RECEIVED', 'ISSUED_DAY_STORE', 'ISSUED_PRODUCTION');

-- FG = "FG transfer to Dispatch" sheet.
-- BILL = "Bill transfer to Dispatch from Accounts" sheet.
CREATE TYPE "DispatchTransferType" AS ENUM ('FG', 'BILL');

-- --------------------------------------------------------------------------
-- Tables
-- --------------------------------------------------------------------------

-- Item master catalog — "List from Sanjay & naveen. Option to add item".
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT, -- typical unit of measure, e.g. Kg / Ltr / Count
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- One row per Material Received / Material Issued (day store or
-- production) entry off the Warehouse tool. `unit`/`size` are recorded
-- per-entry (not just read off the item) because the sheet's examples show
-- them varying per delivery.
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "InventoryTxnType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "unit" TEXT NOT NULL, -- Ltr / Kg / Count, as recorded on this entry
    "quantity" DOUBLE PRECISION NOT NULL, -- the sheet's "Count" field
    "size" TEXT, -- Optional — e.g. Inch / ft / Kg / Ltr sizing note
    "vendorName" TEXT, -- mainly for RECEIVED; optional either direction
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- One row per "FG transfer to Dispatch" / "Bill transfer to Dispatch from
-- Accounts" entry. Customer links to the Order Tracking customer master
-- (customers table) rather than free text. Product Name stays free text —
-- there's no product master in this schema.
CREATE TABLE "dispatch_transfers" (
    "id" TEXT NOT NULL,
    "type" "DispatchTransferType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "productName" TEXT NOT NULL, -- the sheet's "Product Name" — free text, no product master exists
    "quantity" DOUBLE PRECISION NOT NULL, -- the sheet's "Qty"
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_transfers_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------------------------
-- Indexes
-- --------------------------------------------------------------------------

CREATE UNIQUE INDEX "inventory_items_category_name_key" ON "inventory_items"("category", "name");

CREATE INDEX "inventory_transactions_itemId_idx" ON "inventory_transactions"("itemId");
CREATE INDEX "inventory_transactions_type_date_idx" ON "inventory_transactions"("type", "date");

CREATE INDEX "dispatch_transfers_customerId_idx" ON "dispatch_transfers"("customerId");
CREATE INDEX "dispatch_transfers_type_date_idx" ON "dispatch_transfers"("type", "date");

-- --------------------------------------------------------------------------
-- Foreign keys
-- --------------------------------------------------------------------------

ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_transfers" ADD CONSTRAINT "dispatch_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
