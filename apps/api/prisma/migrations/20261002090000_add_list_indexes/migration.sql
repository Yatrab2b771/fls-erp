-- Indexes for the filter / sort columns the paged lists and PPIC tiles hit
CREATE INDEX IF NOT EXISTS "purchase_orders_status_idx" ON "purchase_orders"("status");
CREATE INDEX IF NOT EXISTS "purchase_orders_customerId_idx" ON "purchase_orders"("customerId");
CREATE INDEX IF NOT EXISTS "purchase_orders_createdAt_idx" ON "purchase_orders"("createdAt");
CREATE INDEX IF NOT EXISTS "purchase_orders_orderDate_idx" ON "purchase_orders"("orderDate");
CREATE INDEX IF NOT EXISTS "purchase_orders_poNumber_idx" ON "purchase_orders"("poNumber");
CREATE INDEX IF NOT EXISTS "purchase_order_items_purchaseOrderId_idx" ON "purchase_order_items"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "purchase_order_items_cancelledAt_idx" ON "purchase_order_items"("cancelledAt");
CREATE INDEX IF NOT EXISTS "rm_plans_purchaseOrderItemId_idx" ON "rm_plans"("purchaseOrderItemId");
CREATE INDEX IF NOT EXISTS "bom_plans_purchaseOrderItemId_idx" ON "bom_plans"("purchaseOrderItemId");
CREATE INDEX IF NOT EXISTS "production_batches_status_idx" ON "production_batches"("status");
CREATE INDEX IF NOT EXISTS "customers_companyName_idx" ON "customers"("companyName");
