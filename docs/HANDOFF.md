# StockPilot Backend Handoff

## Project State

- Branch: `Sang`
- Version: `v1.0.0`
- Evidence status: `LOCAL_AND_MYSQL_VERIFIED` for Database Design v1.1 core alignment after the commands listed below passed locally on 2026-09-25.
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

The executable Prisma schema is aligned with Database Design v1.1 at the core foundation level: 29 models / physical tables, including StockTake, StockTakeItem, Notification, AuditLog, AiInteraction, and SystemSetting foundations. Advanced workflows for those new foundations are intentionally deferred.

Store tenancy is enforced through authenticated store scope. Business queries should include `storeId` unless the model is explicitly global.

The Decision Engine is deterministic TypeScript logic. AI endpoints may explain already authorized deterministic outputs, but AI does not mutate inventory, pricing, orders, returns, alerts, or recommendations.

## Database

- Schema: `prisma/schema.prisma`
- Migrations: `prisma/migrations`
- Current migration count: 12
- Current Prisma model count: 29
- Latest migration: `20260925213000_v12_core_architecture_alignment`
- Clean deployment command: `npm run prisma:migrate:deploy`
- Client generation: `npm run prisma:generate`

Never rewrite reviewed historical migrations. Add a new V13+ migration for future schema changes.

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
npx prisma validate
npm run prisma:generate
npm run prisma:migrate:deploy
npm run typecheck
npm run lint
npm run dev
npm run build
npm test
npm run test:coverage
npm run handoff:check
```

Latest local evidence for this handoff pass:

- `npm ci`: passed, 0 vulnerabilities; dependency deprecation warnings only.
- `npx prisma validate`: passed.
- `npm run prisma:generate`: passed.
- `npx prisma migrate deploy`: passed on `stockpilot_dev`; clean reset/deploy also passed on isolated `stockpilot_test`.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 4 existing `no-console` warnings in `src/server.ts`.
- `npm run build`: passed.
- `npm test`: 20 suites / 129 tests passed.
- `npm run handoff:check`: passed; reported `HANDOFF_CHECK_OK` with expected local `.env` warning.

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
