-- CreateIndex
CREATE INDEX "inventory_transactions_itemId_type_receiptStatus_idx" ON "inventory_transactions"("itemId", "type", "receiptStatus");

