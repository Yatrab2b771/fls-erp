-- Split MATERIAL ISSUED into two destinations per the updated "Inventory
-- tool.xlsx": "Issued to day store" and "Issued to Production". Existing
-- ISSUED rows are all day-store entries (Production wasn't tracked before),
-- so the rename preserves their meaning; the new value is added separately.

ALTER TYPE "InventoryTxnType" RENAME VALUE 'ISSUED' TO 'ISSUED_DAY_STORE';

ALTER TYPE "InventoryTxnType" ADD VALUE 'ISSUED_PRODUCTION';
