# StockPilot Backend API Contracts

System version: `v1.0.0` backend handoff candidate
Base URL: `/api/v1`
Business timezone: `Asia/Ho_Chi_Minh`

Authentication uses `Authorization: Bearer <accessToken>` unless an endpoint is marked public. Store-scoped endpoints derive store access from authenticated user context and RBAC middleware.

## Common Response Envelope

Success responses generally use:

```json
{
  "success": true,
  "data": {}
}
```

Error responses use:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": {},
    "requestId": "request-id"
  }
}
```

Common error codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT_EXCEEDED`, and domain-specific business errors.

## Idempotency

Supported mutation endpoints accept `Idempotency-Key`.

- Same key + same request can replay the original completed response.
- Same key + different request returns a conflict.
- Expired in-progress records are recovered from durable business effects where supported.

## Endpoints

| Method | Path | Auth | Role | Store scope | Request shape | Response shape | Idempotency |
|---|---|---|---|---|---|---|---|
| GET | `/health` | Public | Any | No | none | health status | No |
| GET | `/health/live` | Public | Any | No | none | liveness status | No |
| GET | `/health/ready` | Public | Any | No | none | readiness + DB status | No |
| POST | `/auth/register` | Public | Any | No | `{ fullName, email, password, storeName, storeCode, phone?, address? }` | user/store/session tokens | No |
| POST | `/auth/login` | Public | Any | No | `{ email, password }` | user/session tokens | No |
| POST | `/auth/refresh` | Public | Any | No | `{ refreshToken }` | rotated session tokens | No |
| POST | `/auth/forgot-password` | Public | Any | No | `{ email }` | generic accepted response; non-production may include dev reset token | No |
| POST | `/auth/reset-password` | Public | Any | No | `{ token, newPassword }` | reset status and refresh-session revocation | No |
| POST | `/auth/logout` | Bearer | Authenticated | User session | `{ refreshToken? }` | logout status | No |
| GET | `/auth/me` | Bearer | Authenticated | User session | none | current user | No |
| PATCH | `/auth/me` | Bearer | Authenticated | User session | `{ fullName }` | updated current user profile | No |
| POST | `/users` | Bearer | `SHOP_OWNER` | Yes | `{ fullName, email, password }` | created staff user | No |
| GET | `/users` | Bearer | `SHOP_OWNER` | Yes | query pagination if supported | users list | No |
| PATCH | `/users/:id` | Bearer | `SHOP_OWNER` | Yes | `{ fullName?, isActive? }` | updated same-store warehouse staff user | No |
| GET | `/categories` | Bearer | Store user | Yes | query pagination if supported | category list | No |
| GET | `/categories/:id` | Bearer | Store user | Yes | path `id` | category detail | No |
| POST | `/categories` | Bearer | `SHOP_OWNER` | Yes | `{ name, code, description? }` | created category | No |
| PUT | `/categories/:id` | Bearer | `SHOP_OWNER` | Yes | `{ name?, description?, isActive? }` | updated category | No |
| DELETE | `/categories/:id` | Bearer | `SHOP_OWNER` | Yes | path `id` | delete status | No |
| GET | `/products` | Bearer | Store user | Yes | query filters/pagination if supported | product list | No |
| GET | `/products/:id` | Bearer | Store user | Yes | path `id` | product detail | No |
| POST | `/products` | Bearer | `SHOP_OWNER` | Yes | `{ categoryId?, name, code, description?, items[] }` | created product with stock items | No |
| PUT | `/products/:id` | Bearer | `SHOP_OWNER` | Yes | `{ categoryId?, name?, description?, isActive? }` | updated product | No |
| GET | `/inventory/balances` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters/pagination if supported | balances | No |
| GET | `/inventory/movements` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters/pagination if supported | stock movements | No |
| POST | `/inventory/inflow` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ warehouseId?, items: [{ stockItemId, quantity }], referenceId?, note? }` | ledger mutation result | Yes |
| POST | `/inventory/outflow` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ warehouseId?, items: [{ stockItemId, quantity }], referenceId?, note? }` | ledger mutation result | Yes |
| POST | `/inventory/audit` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ warehouseId?, items: [{ stockItemId, countedQuantity }], referenceId?, note? }` | audit adjustment result | Yes |
| POST | `/stock-takes` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ warehouseId, note? }` | created DRAFT stock take | Yes |
| GET | `/stock-takes` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ status?, warehouseId?, page?, limit? }` | stock take page | No |
| GET | `/stock-takes/:id` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | stock take detail with items | No |
| POST | `/stock-takes/:id/start` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | IN_PROGRESS stock take with snapshotted items | Yes |
| PUT | `/stock-takes/:id/counts` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ items: [{ stockItemId, countedQuantity, note? }] }` | updated stock take detail | Yes |
| POST | `/stock-takes/:id/complete` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | COMPLETED stock take with adjustment movement links | Yes |
| POST | `/stock-takes/:id/cancel` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | CANCELED stock take | Yes |
| GET | `/notifications` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ isRead?, page?, limit? }` | current user's notification page | No |
| POST | `/notifications/:id/read` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | notification marked read | No |
| POST | `/notifications/read-all` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | none | current user's unread count marked read | No |
| GET | `/orders` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters/pagination if supported | order list | No |
| GET | `/orders/:id` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | order detail | No |
| POST | `/orders` | Bearer | `SHOP_OWNER` | Yes | `{ customerName?, customerPhone?, customerAddress?, discountAmount?, taxAmount?, note?, items[] }` | created order | Yes |
| POST | `/orders/:id/confirm` | Bearer | `SHOP_OWNER` | Yes | path `id` | confirmed order and inventory result | Yes |
| POST | `/orders/:id/fulfill` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | fulfilled order | No |
| POST | `/orders/:id/cancel` | Bearer | `SHOP_OWNER` | Yes | `{ cancelReason }` | canceled order and restock result | Yes |
| GET | `/returns` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters/pagination if supported | return list | No |
| POST | `/returns` | Bearer | `SHOP_OWNER` | Yes | `{ orderId, reason, items: [{ orderItemId, quantity, isRestockable?, note? }] }` | created return | Yes |
| GET | `/analytics/dashboard` | Bearer | `SHOP_OWNER` | Yes | query timeframe if supported | dashboard data | No |
| POST | `/import/preview` | Bearer | `SHOP_OWNER` | Yes | `{ mode?, warehouseId?, items[] }` | preview job and row validation | No |
| POST | `/import/commit` | Bearer | `SHOP_OWNER` | Yes | `{ jobId }` | import commit result | Yes |
| GET | `/export/products` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters if supported | CSV response; omits cost price for warehouse staff | No |
| GET | `/export/inventory` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters if supported | CSV response; omits cost price for warehouse staff | No |
| GET | `/export/orders` | Bearer | `SHOP_OWNER` | Yes | query filters if supported | CSV response | No |
| GET | `/export/sales` | Bearer | `SHOP_OWNER` | Yes | query filters if supported | CSV response | No |
| GET | `/export/returns` | Bearer | `SHOP_OWNER` | Yes | query filters if supported | CSV response | No |
| GET | `/export/decision-report` | Bearer | `SHOP_OWNER` | Yes | query filters if supported | CSV response | No |
| GET | `/export/alerts` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | query filters if supported | CSV response | No |
| GET | `/export/recommendations` | Bearer | `SHOP_OWNER` | Yes | query filters if supported | CSV response | No |
| POST | `/historical-sales/preview` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ rows: [{ externalOrderId?, sku, quantity, unitPrice, costPrice?, unitCost?, soldAt, source? }] }` | preview job and validation | No |
| POST | `/historical-sales/commit` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ jobId }` | commit result | Yes |
| GET | `/historical-sales` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ sku?, stockItemId?, source?, from?, to?, page?, limit? }` | historical sales page | No |
| POST | `/import/historical-sales/preview` | Bearer | Compatibility alias | Yes | same as `/historical-sales/preview` | same response | No |
| POST | `/import/historical-sales/commit` | Bearer | Compatibility alias | Yes | same as `/historical-sales/commit` | same response | Yes |
| GET | `/import/historical-sales` | Bearer | Compatibility alias | Yes | same as `/historical-sales` | same response | No |
| GET | `/decision-engine/sku/:stockItemId` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `stockItemId` | deterministic SKU analysis | No |
| GET | `/decision-engine/overview` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ riskFilter?, page?, limit? }` | paged overview | No |
| POST | `/decision-engine/recalculate` | Bearer | `SHOP_OWNER` | Yes | optional body per implementation | persisted alerts/snapshots/recommendations | No |
| GET | `/decision-engine/config` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | none | engine config | No |
| PUT | `/decision-engine/config` | Bearer | `SHOP_OWNER` | Yes | partial engine config fields | updated config | No |
| GET | `/decision-engine/policy/:stockItemId?` | Bearer | Compatibility alias | Yes | optional path `stockItemId` | same config/policy behavior | No |
| PUT | `/decision-engine/policy/:stockItemId?` | Bearer | Compatibility alias | Yes | same as config update | same response | No |
| GET | `/alerts` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ status?, type?, severity?, stockItemId?, page?, limit? }` | alert page | No |
| POST | `/alerts/:id/acknowledge` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | acknowledged alert | No |
| POST | `/alerts/:id/resolve` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | path `id` | resolved alert | No |
| GET | `/pricing` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ status?, stockItemId?, page?, limit? }` | recommendation page | No |
| POST | `/pricing/:id/accept` | Bearer | `SHOP_OWNER` | Yes | `{ applyToStockItem? }` | accepted recommendation | No |
| POST | `/pricing/:id/reject` | Bearer | `SHOP_OWNER` | Yes | path `id` | rejected recommendation | No |
| POST | `/pricing/:id/modify` | Bearer | `SHOP_OWNER` | Yes | `{ customPrice, applyToStockItem? }` | modified recommendation | No |
| GET | `/recommendations` | Bearer | Compatibility alias | Yes | same as `/pricing` | same response | No |
| POST | `/recommendations/:id/accept` | Bearer | Compatibility alias | Yes | same as `/pricing/:id/accept` | same response | No |
| POST | `/recommendations/:id/reject` | Bearer | Compatibility alias | Yes | same as `/pricing/:id/reject` | same response | No |
| POST | `/recommendations/:id/modify` | Bearer | Compatibility alias | Yes | same as `/pricing/:id/modify` | same response | No |
| GET | `/assistant/sku/:stockItemId` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ question? }` | explanation of authorized SKU analysis | No |
| GET | `/assistant/overview` | Bearer | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Yes | `{ timeframeDays? }` | store summary explanation | No |

## Contract Rules

- Do not add endpoints only to mirror database tables.
- Do not break existing request/response contracts without an explicit API task.
- Keep compatibility aliases documented while they remain mounted in `src/app.ts`.
- Update this file whenever an endpoint, request shape, response shape, auth rule, role rule, or idempotency rule changes.

## Account Management

- `PATCH /auth/me` updates only current-user profile fields present in the executable `User` model. The current implementation allows `fullName`; it rejects attempts to mutate `id`, `storeId`, `role`, `isActive`, password hashes, tokens, or unknown fields.
- Password recovery stores only a SHA-256 hash of the reset token in `password_reset_tokens`. Tokens expire after 30 minutes, are single-use, and successful reset revokes active refresh sessions for the user. Forgot-password responses are generic to avoid email enumeration; production HTTP responses do not expose raw reset tokens.
- `PATCH /users/:id` is owner-only and targets only same-store `WAREHOUSE_STAFF` accounts. It does not update owner/admin accounts, roles, store assignment, email, password, or token fields. Setting `isActive=false` disables the staff user and revokes active refresh sessions.
- Product archive is represented by `Product.isActive=false` through `PUT /products/:id`. Catalog listing defaults to active products unless `isActive=false` is explicitly requested. Archived products remain readable by direct detail/history references but cannot be used for new order creation through active stock item lookup.

## StockTake Workflow

StockTake lifecycle is `DRAFT -> IN_PROGRESS -> COMPLETED`, with `DRAFT -> CANCELED` and `IN_PROGRESS -> CANCELED`. `COMPLETED` and `CANCELED` are terminal.

- `POST /stock-takes` creates only the StockTake header. It does not snapshot or mutate inventory.
- `POST /stock-takes/:id/start` snapshots current `InventoryBalance` rows for the selected warehouse into `StockTakeItem` rows. Initial `countedQuantity` equals `expectedQuantity`, so initial `varianceQuantity` is `0`.
- `PUT /stock-takes/:id/counts` updates counted quantities only while the StockTake is `IN_PROGRESS`. The server derives `varianceQuantity = countedQuantity - expectedQuantity`.
- `POST /stock-takes/:id/complete` atomically applies final physical counts to inventory. Non-zero balance adjustments create `AUDIT_ADJUSTMENT` `StockMovement` rows with `referenceType = STOCK_TAKE`, and each movement is linked from `StockTakeItem.adjustmentMovementId`.
- Completion rejects counts that would violate inventory invariants such as `reservedQuantity <= quantity`.
- `POST /stock-takes/:id/cancel` never mutates inventory and never creates stock movements.

## Notification Center

The minimal Notification Center is a per-user inbox over existing `Notification` rows.

- `GET /notifications` returns only rows where `storeId` and `userId` match the authenticated user.
- `isRead=true|false` filters by read state when supplied.
- `POST /notifications/:id/read` marks one owned notification as read and sets `readAt`.
- `POST /notifications/read-all` marks unread rows for the authenticated user as read.
- `userId = null` notification rows are not exposed by the minimal inbox because broadcast read-state is deferred.
- Realtime delivery, push/SSE/WebSocket, broadcast recipient expansion, and read-receipt tables are not part of this API.
