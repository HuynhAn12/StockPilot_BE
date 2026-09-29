# Business Rules

Rules in this file are grounded in current docs, source code, tests, and approved database design artifacts. Items marked `NEEDS CONFIRMATION` should not be treated as final product rules.

## Inventory

### INV-001

Inventory quantity must never be negative.

### INV-002

`reservedQuantity` must satisfy `0 <= reservedQuantity <= quantity`.

### INV-003

Every successful inventory mutation must create a `StockMovement`.

### INV-004

Inventory balance changes and stock movements must be consistent in the same transaction.

### INV-005

Product CRUD must not directly edit stock quantity.

## StockTake

### STK-001

StockTake lifecycle is `DRAFT -> IN_PROGRESS -> COMPLETED`, with `DRAFT -> CANCELED` and `IN_PROGRESS -> CANCELED`. `COMPLETED` and `CANCELED` are terminal.

### STK-002

Starting a StockTake snapshots current warehouse balances into StockTakeItem rows. Initial counted quantity equals expected quantity.

### STK-003

Counting does not mutate inventory. It only updates counted quantity and the server-derived variance.

### STK-004

StockTake variance is always `countedQuantity - expectedQuantity` and must not be accepted from the client.

### STK-005

Completing a StockTake is atomic: inventory balances, stock movements, StockTakeItem adjustment links, and StockTake status must commit or roll back together.

### STK-006

Every non-zero StockTake inventory adjustment must create an `AUDIT_ADJUSTMENT` StockMovement linked by `StockTakeItem.adjustmentMovementId`.

### STK-007

StockTake completion must preserve inventory invariants, including `quantity >= 0` and `reservedQuantity <= quantity`.

## Store Isolation

### TEN-001

Store-owned resources must be scoped by `storeId`.

### TEN-002

Do not authorize or mutate a store-owned resource by primary key alone.

### TEN-003

`ADMIN` is not a store operator for store-scoped APIs unless a dedicated admin API exists.

## Accounts

### ACC-001

Current-user profile updates may change only allowed profile fields from the current `User` model. Users must not self-change role, store, active status, email, password hash, token/session fields, or admin/system fields through the profile endpoint.

### ACC-002

Staff update/disable is owner-only, same-store scoped, and limited to `WAREHOUSE_STAFF` targets.

### ACC-003

Disabled users cannot log in or use authenticated/refresh flows. Disabling staff and successful password reset revoke active refresh sessions.

### ACC-004

Password reset tokens are hash-only, expiring, single-use credentials. Forgot-password responses must remain generic to avoid email enumeration.

## Products

### PRD-001

Product archive is represented by `Product.isActive = false`; no hard delete is required for archive semantics.

### PRD-002

Default catalog listing returns active products unless an explicit `isActive` filter is supplied.

### PRD-003

Archived products remain readable by direct/historical references, but their stock items cannot be used to create new orders where active product status is required.

## Orders

### ORD-001

Fulfillment and inventory deduction must be atomic.

### ORD-002

An order cannot be fulfilled twice.

### ORD-003

`OrderItem` stores sale-time snapshots for SKU, name, unit price, cost, quantity, subtotal, and refundable amount.

### ORD-004

Confirmed orders deduct inventory; draft orders do not reserve stock in the current MVP.

### ORD-005

Canceled confirmed orders restock through the inventory ledger. Fulfilled orders must go through returns instead of cancellation.

## Returns

### RET-001

Returned quantity cannot exceed sold quantity.

### RET-002

Refund calculations use stored snapshot/refundable values, not current product prices.

### RET-003

Restockable returns create inventory ledger movements.

### RET-004

Non-restockable returns do not reverse COGS in the current MVP.

## Money And Accounting

### MON-001

Money uses `DECIMAL(15,2)` in the database.

### MON-002

Fulfilled order revenue uses `OrderItem.refundableAmount`.

### MON-003

`ReturnItem.refundPrice` is the total refund amount for the return line.

### MON-004

Historical sales with missing cost never fall back to current SKU cost.

### MON-005

Business dates use `APP_TIMEZONE=Asia/Ho_Chi_Minh` and half-open `[start, end)` intervals.

## Import And Idempotency

### IMP-001

Import preview validates data without committing business changes.

### IMP-002

Import commit is based on a durable preview job.

### IDE-001

Supported mutation endpoints use `Idempotency-Key` to replay identical completed requests and reject conflicting reuse.

## Pricing

### PRI-001

Pricing recommendations are advisory until an authorized `SHOP_OWNER` accepts, rejects, or modifies them.

### PRI-002

Pricing recommendation approval is serialized and guards stale current prices.

### PRI-003

Warehouse staff must not receive sensitive cost or margin fields.

## Notifications

### NOT-001

Notification Center inbox queries are per-user and store-scoped: `storeId` and `userId` must match the authenticated user.

### NOT-002

Minimal Notification Center APIs do not expose `userId = null` notification rows because broadcast read-state is deferred.

### NOT-003

Marking notifications as read is idempotent and only changes the authenticated user's own notification rows.

## Decision Engine

### DEC-001

Decision Engine output is deterministic TypeScript logic.

### DEC-002

AI must not replace business formulas, thresholds, or deterministic scoring.

### DEC-003

Alerts use the current taxonomy: `LOW_STOCK`, `STOCKOUT`, `OVERSTOCK`, `SLOW_MOVING`, `DEAD_STOCK`, and `UNUSUAL_DEMAND`.

## AI

### AI-001

AI output is explanatory only.

### AI-002

AI must not mutate inventory, orders, returns, prices, alerts, or recommendations.

### AI-003

Do not send passwords, JWTs, refresh tokens, database credentials, or unnecessary customer PII to AI providers.

## Deferred Foundations

### DEF-001

Notification realtime delivery and broadcast/read-receipt behavior are deferred.

### DEF-002

AuditLog tables exist, but full mutation coverage is deferred.

### DEF-003

SystemSetting tables exist, but the admin API is deferred.

### DEF-004

AiInteraction tables exist, but conversation management UI/API is deferred.
