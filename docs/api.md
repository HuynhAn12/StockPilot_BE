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
| POST | `/auth/logout` | Bearer | Authenticated | User session | `{ refreshToken? }` | logout status | No |
| GET | `/auth/me` | Bearer | Authenticated | User session | none | current user | No |
| POST | `/users` | Bearer | `SHOP_OWNER` | Yes | `{ fullName, email, password }` | created staff user | No |
| GET | `/users` | Bearer | `SHOP_OWNER` | Yes | query pagination if supported | users list | No |
| GET | `/categories` | Bearer | Store user | Yes | query pagination if supported | category list | No |
| GET | `/categories/:id` | Bearer | Store user | Yes | path `id` | category detail | No |
| POST | `/categories` | Bearer | `SHOP_OWNER` | Yes | `{ name, code, description? }` | created category | No |
| PUT | `/categories/:id` | Bearer | `SHOP_OWNER` | Yes | `{ name?, description?, isActive? }` | updated category | No |
| DELETE | `/categories/:id` | Bearer | `SHOP_OWNER` | Yes | path `id` | delete status | No |
| GET | `/products` | Bearer | Store user | Yes | query filters/pagination if supported | product list | No |
| GET | `/products/:id` | Bearer | Store user | Yes | path `id` | product detail | No |
| POST | `/products` | Bearer | `SHOP_OWNER` | Yes | `{ categoryId?, name, code, description?, items[] }` | created product with stock items | No |
| PUT | `/products/:id` | Bearer | `SHOP_OWNER` | Yes | `{ categoryId?, name?, description?, isActive? }` | updated product | No |
| GET | `/inventory/balances` | Bearer | Store user | Yes | query filters/pagination if supported | balances | No |
| GET | `/inventory/movements` | Bearer | Store user | Yes | query filters/pagination if supported | stock movements | No |
| POST | `/inventory/inflow` | Bearer | Store user | Yes | `{ warehouseId?, items: [{ stockItemId, quantity }], referenceId?, note? }` | ledger mutation result | Yes |
| POST | `/inventory/outflow` | Bearer | Store user | Yes | `{ warehouseId?, items: [{ stockItemId, quantity }], referenceId?, note? }` | ledger mutation result | Yes |
| POST | `/inventory/audit` | Bearer | Store user | Yes | `{ warehouseId?, items: [{ stockItemId, countedQuantity }], referenceId?, note? }` | audit adjustment result | Yes |
| GET | `/orders` | Bearer | Store user | Yes | query filters/pagination if supported | order list | No |
| GET | `/orders/:id` | Bearer | Store user | Yes | path `id` | order detail | No |
| POST | `/orders` | Bearer | Store user | Yes | `{ customerName?, customerPhone?, customerAddress?, discountAmount?, taxAmount?, note?, items[] }` | created order | Yes |
| POST | `/orders/:id/confirm` | Bearer | Store user | Yes | path `id` | confirmed order and inventory result | Yes |
| POST | `/orders/:id/fulfill` | Bearer | Store user | Yes | path `id` | fulfilled order | No |
| POST | `/orders/:id/cancel` | Bearer | Store user | Yes | `{ cancelReason }` | canceled order and restock result | Yes |
| GET | `/returns` | Bearer | Store user | Yes | query filters/pagination if supported | return list | No |
| POST | `/returns` | Bearer | Store user | Yes | `{ orderId, reason, items: [{ orderItemId, quantity, isRestockable?, note? }] }` | created return | Yes |
| GET | `/analytics/dashboard` | Bearer | `SHOP_OWNER` | Yes | query timeframe if supported | dashboard data | No |
| POST | `/import/preview` | Bearer | `SHOP_OWNER` | Yes | `{ mode?, warehouseId?, items[] }` | preview job and row validation | No |
| POST | `/import/commit` | Bearer | `SHOP_OWNER` | Yes | `{ jobId }` | import commit result | Yes |
| GET | `/export/products` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/inventory` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/orders` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/sales` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/returns` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/decision-report` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/alerts` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
| GET | `/export/recommendations` | Bearer | Store user | Yes | query filters if supported | CSV response | No |
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
