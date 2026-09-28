# StockPilot Database

## Source Of Truth

- Target database: Database Design v1.1
- Executable schema: `prisma/schema.prisma`
- Migration history: `prisma/migrations/`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.1_Complete_Design.sql`

The consolidated SQL is a reference artifact for design comparison. It does not replace Prisma migration history.

## Current Schema Alignment

- Target physical table count: 29
- Executable Prisma model count: 29
- Current migration count: 12
- Latest migration: `20260925213000_v12_core_architecture_alignment`
- Current status: executable Prisma schema is aligned with Database Design v1.1 at the database/model foundation level

The v1.1 foundation models exist:

- `StockTake`
- `StockTakeItem`
- `Notification`
- `AuditLog`
- `AiInteraction`
- `SystemSetting`

These are database foundations only unless an API/workflow is documented in `docs/api.md` and implemented in `src/modules`.

## Migration Policy

- Historical migrations are immutable.
- Do not edit reviewed/applied migration SQL.
- Every database schema change must create a new migration after the latest migration.
- `prisma db push` is not the deployment workflow.
- Clean deployment should work with `npx prisma migrate deploy`.

## Money

- Money columns use `DECIMAL(15,2)`.
- Do not use float/double for money.
- Sale and refund calculations must use persisted snapshots where available.

## Tenant / Store Isolation

StockPilot uses a shared database and shared schema. Store-owned tables include `storeId` and application code must enforce same-store ownership before reads or writes.

Do not rely on a bare `id` lookup for tenant-owned resources.

## Key Invariants

- `inventory_balances.quantity >= 0`
- `inventory_balances.reservedQuantity >= 0`
- `inventory_balances.reservedQuantity <= inventory_balances.quantity`
- `stock_take_items.expectedQuantity >= 0`
- `stock_take_items.countedQuantity >= 0`
- `stock_take_items.varianceQuantity = countedQuantity - expectedQuantity`
- Inventory mutations must create `stock_movements`
- Return quantities and refund amounts are capped by persisted order item values
- Alert taxonomy is `LOW_STOCK`, `STOCKOUT`, `OVERSTOCK`, `SLOW_MOVING`, `DEAD_STOCK`, `UNUSUAL_DEMAND`

## Core Tables

Primary implemented domains:

- Access: `stores`, `users`, `auth_sessions`
- Catalog: `categories`, `products`, `stock_items`
- Inventory: `warehouses`, `inventory_balances`, `stock_movements`
- Orders and returns: `orders`, `order_items`, `return_orders`, `return_items`
- Import/idempotency/history: `import_jobs`, `import_job_items`, `idempotency_requests`, `historical_sales`, `daily_sales_summaries`
- Decision support: `engine_configs`, `alerts`, `pricing_recommendations`, `price_histories`, `decision_snapshots`
- v1.1 foundations: `stock_takes`, `stock_take_items`, `notifications`, `audit_logs`, `ai_interactions`, `system_settings`

## Deferred Database-Backed Features

The following tables exist but full application workflows are deferred:

- Notification delivery and notification center
- Full audit coverage
- SystemSetting admin API
- AI conversation history UI/API
