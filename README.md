# StockPilot Backend

StockPilot is a TypeScript backend for store-scoped inventory, order, returns, analytics, import/export, and deterministic inventory decision support. This repository is a backend handoff candidate, not a production-readiness claim.

## Stack

- Node.js 24 LTS recommended
- Express.js
- TypeScript
- Prisma 5
- MySQL 8.4 / InnoDB
- Zod validation
- JWT auth with refresh-token rotation
- Jest and Supertest

## Directory Overview

```text
backend/
  prisma/              Prisma schema and immutable migration history
  scripts/             Maintenance and handoff helper scripts
  src/app.ts           Express application and mounted API routes
  src/config/          Environment and Prisma client setup
  src/common/          Shared errors, middleware, auth, RBAC, utilities
  src/modules/         Modular monolith business modules
  tests/               Unit, API integration, MySQL, and concurrency tests
  docs/                API, handoff, runbook, testing, and limitations docs
```

## Environment

Copy `.env.example` to `.env` for local development and set real values:

```bash
cp .env.example .env
```

Required production variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `CORS_ORIGIN` with an explicit origin, not `*`
- `APP_TIMEZONE=Asia/Ho_Chi_Minh`

`TEST_DATABASE_URL` must point to an isolated throwaway MySQL database used only for tests.

## Setup

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

The API listens on `http://localhost:5000/api/v1` by default.

## Migration Workflow

Use Prisma migrations as the source of truth.

- Development schema change: `npm run prisma:migrate`
- Fresh shared/staging/deploy database: `npm run prisma:migrate:deploy`
- Generate client: `npm run prisma:generate`

Do not edit existing migration SQL after it has been reviewed/applied. Do not use `prisma db push` as the team setup or deployment workflow.

## Tests

```bash
npx prisma validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm test
npm run test:coverage
```

Real MySQL suites require `TEST_DATABASE_URL` and include accounting, idempotency, pricing, import, and concurrency coverage. The tests contain destructive cleanup guards and should only target a test database.

## Maintenance

Daily sales summary reconciliation for the V10 timezone/accounting boundary:

```bash
npm run maintenance:rebuild-summary-v10 -- --dry-run
npm run maintenance:rebuild-summary-v10 -- --storeId=1 --dry-run
npm run maintenance:rebuild-summary-v10 -- --storeId=1
```

The maintenance script is not run during server startup.

## Core Invariants

- Store data is tenant-scoped by authenticated store context.
- Fulfilled order revenue uses `OrderItem.refundableAmount`.
- `ReturnItem.refundPrice` is a total refund amount for the return line.
- Return-only days may produce negative `netSoldQty` and `netRevenue`.
- Restockable returns reverse COGS using `OrderItem.costPriceSnapshot`.
- Non-restockable returns do not reverse COGS in the current MVP.
- Historical sales with missing cost never fall back to current SKU cost.
- Business dates use `APP_TIMEZONE=Asia/Ho_Chi_Minh` and half-open `[start, end)` intervals.
- Decision Engine output is deterministic; AI explanation endpoints are read-only wrappers around authorized deterministic output.
- Pricing recommendation approval is serialized and guards stale recommendations.

## Roles

- `SHOP_OWNER`: manages store data, staff, pricing approvals, and engine config.
- `WAREHOUSE_STAFF`: can operate inventory/orders/returns and read operational reports where allowed; sensitive cost fields are masked.
- `ADMIN`: blocked from store-scoped APIs unless a dedicated admin API exists.

## Documentation

Start with [docs/HANDOFF.md](docs/HANDOFF.md), then use:

- [docs/api.md](docs/api.md)
- [docs/RUNBOOK.md](docs/RUNBOOK.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)

## Troubleshooting

- If Prisma types look stale, run `npm run prisma:generate`.
- If migrations fail on a fresh DB, verify `DATABASE_URL` points to an empty MySQL schema and run `npm run prisma:migrate:deploy`.
- If tests refuse to run, check that `TEST_DATABASE_URL` targets an isolated test database.
- If business dates look off, verify `APP_TIMEZONE=Asia/Ho_Chi_Minh`.
- If summary analytics look duplicated around the V10 boundary, run the V10 rebuild in dry-run mode first.
