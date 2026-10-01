# StockPilot Database

## Source Of Truth

- Target database: Database Design v1.2
- Executable schema: `prisma/schema.prisma`
- Migration history: `prisma/migrations/`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.2_Complete_Design.sql`

The executable Prisma schema and immutable Prisma migration history are authoritative. The consolidated SQL is a reference artifact for design comparison and direct database review; it does not replace the migration ledger.

## Current Schema Alignment

- Database Design v1.2 target physical table count: 30
- Executable physical table count: 31
- Executable Prisma model count: 31
- Current migration count: 14
- Latest migration: `20261001120000_v14_store_payment_configs`
- Current status: executable Prisma schema extends Database Design v1.2 with the Phase 3B per-store payment configuration foundation.

`password_reset_tokens` is part of the current schema, not an out-of-band add-on.

## Migration Policy

- Historical migrations are immutable.
- Do not edit reviewed/applied migration SQL.
- Every database schema change must create a new migration after the latest migration.
- `prisma db push` is not the deployment workflow.
- Clean deployment should work with `npx prisma migrate deploy`.

## Physical Tables

Account / Access / Config:

- `stores`
- `users`
- `auth_sessions`
- `password_reset_tokens`
- `system_settings`
- `store_payment_configs`

Catalog:

- `categories`
- `products`
- `stock_items`

Inventory:

- `warehouses`
- `inventory_balances`
- `stock_movements`
- `stock_takes`
- `stock_take_items`

Orders / Returns:

- `orders`
- `order_items`
- `return_orders`
- `return_items`

Import / Idempotency:

- `import_jobs`
- `import_job_items`
- `idempotency_requests`

Sales Analytics:

- `historical_sales`
- `daily_sales_summaries`

Decision Support:

- `engine_configs`
- `alerts`
- `pricing_recommendations`
- `price_histories`
- `decision_snapshots`

Notification / Audit / AI:

- `notifications`
- `audit_logs`
- `ai_interactions`

## Tenant / Store Isolation

StockPilot uses a shared database and shared schema. Store-owned business data uses `storeId`, and application code must enforce same-store ownership before reads or writes.

Not every table is required to have `storeId`:

- `system_settings` is global/system-level and has no `storeId`.
- `users.storeId` is nullable to support system/admin accounts outside a store.
- `password_reset_tokens` is scoped through `userId`; token lookup validates through the related `User`, and the foreign key deletes reset tokens when the user is deleted.

Do not rely on a bare `id` lookup for tenant-owned resources.

## Key Fields And Constraints

Orders:

- `orders.clientRequestKey String? @db.VarChar(200)`
- `orders` has `@@unique([storeId, clientRequestKey])`

Returns:

- `return_orders.clientRequestKey String? @db.VarChar(200)`
- `return_orders` has `@@unique([storeId, clientRequestKey])`

Sales analytics:

- `historical_sales.costPriceSnapshot Decimal? @db.Decimal(15, 2)`
- `daily_sales_summaries.historicalCostMissingQty Int @default(0)`

Password reset tokens:

- Table: `password_reset_tokens`
- Fields: `id`, `userId`, `tokenHash`, `expiresAt`, `usedAt`, `createdAt`
- `tokenHash` is unique and stores only the hash, not the raw token.
- Index: `(userId, expiresAt)`
- Foreign key: `userId -> users.id ON DELETE CASCADE`

Payment provider configuration:

- Table: `store_payment_configs`
- Provider enum: `PAYOS`
- Unique key: `(storeId, provider)`
- Fields: `clientIdEncrypted`, `apiKeyEncrypted`, and `checksumKeyEncrypted`
- Credentials are AES-256-GCM encrypted with `PAYMENT_CONFIG_ENCRYPTION_KEY`.
- The table is a configuration foundation only. It is not a payment record, receipt table, webhook ledger, refund table, or POS subsystem.

Catalog naming:

- `stock_items` is the current sellable SKU / product variant level table. Do not rename it in documentation or schema.

## Money

- Money columns use `DECIMAL(15,2)`.
- Do not use float/double for money.
- Sale and refund calculations must use persisted snapshots where available.
- Order item sale-time snapshots include SKU, name, unit price, cost price, quantity, subtotal, and refundable amount.
- Return/refund calculations are capped by persisted `order_items` values.

## Key Invariants

- `inventory_balances.quantity >= 0`
- `inventory_balances.reservedQuantity >= 0`
- `inventory_balances.reservedQuantity <= inventory_balances.quantity`
- `stock_take_items.expectedQuantity >= 0`
- `stock_take_items.countedQuantity >= 0`
- `stock_take_items.varianceQuantity = countedQuantity - expectedQuantity`
- Inventory mutations must create `stock_movements`.
- Fulfillment and inventory deduction must be atomic.
- Restockable returns must go through the inventory ledger.
- Return quantities and refund amounts are capped by persisted order item values.
- Historical sales with missing cost do not fall back to current SKU cost; missing cost quantity is tracked in `daily_sales_summaries.historicalCostMissingQty`.
- Alert taxonomy is `LOW_STOCK`, `STOCKOUT`, `OVERSTOCK`, `SLOW_MOVING`, `DEAD_STOCK`, `UNUSUAL_DEMAND`.

## Deferred Database-Backed Features

The following tables exist but full application workflows are deferred:

- Notification realtime delivery and broadcast/read-receipt behavior
- Full audit coverage
- SystemSetting admin API
- AI conversation history UI/API
