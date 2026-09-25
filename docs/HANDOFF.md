# StockPilot Backend Handoff

## Project State

- Branch: `Sang`
- Version: `v1.0.0`
- Evidence status: `LOCAL_AND_MYSQL_VERIFIED` after the commands listed in `docs/TESTING.md` pass locally.
- Production observed: `NO`
- Handoff label: `BACKEND_HANDOFF_CANDIDATE`, not production ready.

## Stack

- Node.js 24 LTS
- Express.js
- TypeScript
- Prisma 5
- MySQL 8.4 / InnoDB
- Zod
- Jest and Supertest

## Architecture

The backend is a modular monolith. Modules under `src/modules` own auth, users, categories, products, inventory, orders, returns, analytics, import/export, historical sales, daily summary accounting, alerts, pricing, Decision Engine, and AI explanations.

Store tenancy is enforced through authenticated store scope. Business queries should include `storeId` unless the model is explicitly global.

The Decision Engine is deterministic TypeScript logic. AI endpoints may explain already authorized deterministic outputs, but AI does not mutate inventory, pricing, orders, returns, alerts, or recommendations.

## Database

- Schema: `prisma/schema.prisma`
- Migrations: `prisma/migrations`
- Current migration count: 11
- Clean deployment command: `npm run prisma:migrate:deploy`
- Client generation: `npm run prisma:generate`

Never rewrite reviewed historical migrations. Add a new V11+ migration for future schema changes.

## Environment

Required keys are documented in `.env.example`:

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `TEST_DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `JWT_EXPIRES_IN`
- `JWT_REFRESH_EXPIRES_IN`
- `CORS_ORIGIN`
- `APP_TIMEZONE=Asia/Ho_Chi_Minh`

Production startup requires `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, and a non-wildcard `CORS_ORIGIN`.

## Run Commands

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
npm run build
npm test
npm run test:coverage
npm run handoff:check
```

Maintenance:

```bash
npm run maintenance:rebuild-summary-v10 -- --dry-run
npm run maintenance:rebuild-summary-v10 -- --storeId=1 --dry-run
npm run maintenance:rebuild-summary-v10 -- --storeId=1
```

## Core Business Invariants

- Inventory mutations are ledger-backed and store-scoped.
- Orders snapshot cost and refundable amounts at sale time.
- Fulfilled order revenue uses `OrderItem.refundableAmount`.
- Return refund uses `ReturnItem.refundPrice` as the total return-line refund.
- Restockable returns reverse COGS from `OrderItem.costPriceSnapshot`.
- Non-restockable returns do not reverse COGS in the current MVP.
- Historical missing cost is tracked and never replaced with current SKU cost.
- Daily summary partitions use `APP_TIMEZONE` and half-open intervals.
- Pricing recommendation decisions are single-winner and stale-price guarded.
- Import stock mutation modes use strict fields and durable failed checkpoints.

## Test Evidence Labels

- Accounting: `MYSQL_INTEGRATION_TESTED`
- Decision Engine: `UNIT_TESTED`, `API_INTEGRATION_TESTED`, `MYSQL_INTEGRATION_TESTED`
- Pricing: `MYSQL_INTEGRATION_TESTED`
- Idempotency: `UNIT_TESTED`, `MYSQL_INTEGRATION_TESTED`
- Import: `UNIT_TESTED`, `MYSQL_INTEGRATION_TESTED`
- Auth refresh rotation: `UNIT_TESTED`, `MYSQL_INTEGRATION_TESTED`
- CI: `CI_VERIFIED` only if GitHub Actions passes for the exact handoff SHA.
- Production: `PRODUCTION_OBSERVED` only with real production evidence.

## Known Limitations

See `docs/KNOWN_LIMITATIONS.md`.

## Ownership / Next Work

Safe next ownership areas:

- Frontend integration against `docs/api.md`
- Operational deployment scripts
- Large export streaming/batching
- Decision Engine explainability copy
- Admin-only APIs if the product requires them

## Troubleshooting

- Prisma client stale: run `npm run prisma:generate`.
- Migration error: verify the target database is empty or has the expected migration history, then run `npm run prisma:migrate:deploy`.
- Test DB safety guard: use a database name that clearly identifies it as test-only.
- MySQL connection: verify host, port, user, password, and schema in `DATABASE_URL`/`TEST_DATABASE_URL`.
- Timezone mismatch: set `APP_TIMEZONE=Asia/Ho_Chi_Minh`.
- V10 summary repair: run the rebuild command with `--dry-run` before applying.
