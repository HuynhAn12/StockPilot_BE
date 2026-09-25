# StockPilot Backend API Reference

System version: `v1.0.0` backend handoff candidate
Base URL: `/api/v1`
Business timezone: `Asia/Ho_Chi_Minh`
Registered route count: 69 routes including compatibility aliases
Primary route count: 58 routes excluding compatibility aliases

Authentication uses `Authorization: Bearer <accessToken>` unless marked public. Store-scoped endpoints derive store access from the authenticated user and RBAC middleware.

## Health

| Method | Path | Access |
|---|---|---|
| GET | `/health` | Public |
| GET | `/health/live` | Public |
| GET | `/health/ready` | Public |

## Auth

| Method | Path | Access |
|---|---|---|
| POST | `/auth/register` | Public |
| POST | `/auth/login` | Public |
| POST | `/auth/refresh` | Public |
| POST | `/auth/logout` | Authenticated |
| GET | `/auth/me` | Authenticated |

## Users

| Method | Path | Access |
|---|---|---|
| POST | `/users` | SHOP_OWNER |
| GET | `/users` | SHOP_OWNER |

## Categories

| Method | Path | Access |
|---|---|---|
| GET | `/categories` | Store scoped |
| GET | `/categories/:id` | Store scoped |
| POST | `/categories` | SHOP_OWNER |
| PUT | `/categories/:id` | SHOP_OWNER |
| DELETE | `/categories/:id` | SHOP_OWNER |

## Products

| Method | Path | Access |
|---|---|---|
| GET | `/products` | Store scoped |
| GET | `/products/:id` | Store scoped |
| POST | `/products` | SHOP_OWNER |
| PUT | `/products/:id` | SHOP_OWNER |

## Inventory

| Method | Path | Access |
|---|---|---|
| GET | `/inventory/balances` | Store scoped |
| GET | `/inventory/movements` | Store scoped |
| POST | `/inventory/inflow` | Store scoped, idempotent |
| POST | `/inventory/outflow` | Store scoped, idempotent |
| POST | `/inventory/audit` | Store scoped, idempotent |

## Orders

| Method | Path | Access |
|---|---|---|
| GET | `/orders` | Store scoped |
| GET | `/orders/:id` | Store scoped |
| POST | `/orders` | Store scoped, idempotent |
| POST | `/orders/:id/confirm` | Store scoped, idempotent |
| POST | `/orders/:id/fulfill` | Store scoped |
| POST | `/orders/:id/cancel` | Store scoped, idempotent |

## Returns

| Method | Path | Access |
|---|---|---|
| GET | `/returns` | Store scoped |
| POST | `/returns` | Store scoped, idempotent |

## Analytics

| Method | Path | Access |
|---|---|---|
| GET | `/analytics/dashboard` | SHOP_OWNER |

## Import

| Method | Path | Access |
|---|---|---|
| POST | `/import/preview` | SHOP_OWNER |
| POST | `/import/commit` | SHOP_OWNER, idempotent |

## Historical Sales

The historical sales router is mounted at both `/historical-sales` and `/import/historical-sales` for compatibility.

| Method | Path | Access |
|---|---|---|
| POST | `/historical-sales/preview` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/historical-sales/commit` | SHOP_OWNER, WAREHOUSE_STAFF, idempotent |
| GET | `/historical-sales` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/import/historical-sales/preview` | Compatibility alias |
| POST | `/import/historical-sales/commit` | Compatibility alias |
| GET | `/import/historical-sales` | Compatibility alias |

## Export

| Method | Path | Access |
|---|---|---|
| GET | `/export/products` | Store scoped |
| GET | `/export/inventory` | Store scoped |
| GET | `/export/orders` | Store scoped |
| GET | `/export/sales` | Store scoped |
| GET | `/export/returns` | Store scoped |
| GET | `/export/decision-report` | Store scoped |
| GET | `/export/alerts` | Store scoped |
| GET | `/export/recommendations` | Store scoped |

## Decision Engine

GET analysis routes are read-only. `POST /decision-engine/recalculate` persists alerts, snapshots, and recommendations.

| Method | Path | Access |
|---|---|---|
| GET | `/decision-engine/sku/:stockItemId` | SHOP_OWNER, WAREHOUSE_STAFF |
| GET | `/decision-engine/overview` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/decision-engine/recalculate` | SHOP_OWNER |
| GET | `/decision-engine/config` | SHOP_OWNER, WAREHOUSE_STAFF |
| PUT | `/decision-engine/config` | SHOP_OWNER |
| GET | `/decision-engine/policy/:stockItemId?` | Compatibility alias |
| PUT | `/decision-engine/policy/:stockItemId?` | Compatibility alias |

## Alerts

| Method | Path | Access |
|---|---|---|
| GET | `/alerts` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/alerts/:id/acknowledge` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/alerts/:id/resolve` | SHOP_OWNER, WAREHOUSE_STAFF |

## Pricing Recommendations

The pricing router is mounted at both `/pricing` and `/recommendations` for compatibility.

| Method | Path | Access |
|---|---|---|
| GET | `/pricing` | SHOP_OWNER, WAREHOUSE_STAFF |
| POST | `/pricing/:id/accept` | SHOP_OWNER |
| POST | `/pricing/:id/reject` | SHOP_OWNER |
| POST | `/pricing/:id/modify` | SHOP_OWNER |
| GET | `/recommendations` | Compatibility alias |
| POST | `/recommendations/:id/accept` | Compatibility alias |
| POST | `/recommendations/:id/reject` | Compatibility alias |
| POST | `/recommendations/:id/modify` | Compatibility alias |

## Assistant

AI assistant endpoints explain authorized deterministic Decision Engine output. They do not mutate inventory, price, orders, returns, alerts, or recommendations.

| Method | Path | Access |
|---|---|---|
| GET | `/assistant/sku/:stockItemId` | SHOP_OWNER, WAREHOUSE_STAFF |
| GET | `/assistant/overview` | SHOP_OWNER, WAREHOUSE_STAFF |

## Error Envelope

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

## Idempotency

Supported mutation endpoints accept `Idempotency-Key`. Reusing the same key with the same request can replay the original response. Reusing the same key with a different request returns a conflict. Expired in-progress requests are recovered from durable business effects where supported.
