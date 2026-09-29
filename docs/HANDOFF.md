# StockPilot Backend Handoff

## Project State

- Branch: `Sang`
- Version: `v1.0.0`
- Evidence status: `CI_VERIFIED` for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84`; current Sprint 1 closeout changes require fresh exact-SHA CI verification.
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

The backend is a modular monolith. Modules under `src/modules` own auth, users, categories, products, inventory, orders, returns, analytics, import/export, historical sales, daily summary accounting, StockTake, alerts, pricing, Decision Engine, and AI explanations.

The executable Prisma schema is aligned with Database Design v1.1 plus Sprint 1 password recovery storage: 30 models / physical tables, including StockTake, StockTakeItem, Notification, AuditLog, AiInteraction, SystemSetting foundations, and PasswordResetToken. StockTake has a backend workflow implementation; Notification, full AuditLog coverage, AiInteraction conversation management, and SystemSetting admin workflows remain deferred.

Store tenancy is enforced through authenticated store scope. Business queries should include `storeId` unless the model is explicitly global.

The Decision Engine is deterministic TypeScript logic. AI endpoints may explain already authorized deterministic outputs, but AI does not mutate inventory, pricing, orders, returns, alerts, or recommendations.

## Database

- Schema: `prisma/schema.prisma`
- Migrations: `prisma/migrations`
- Current migration count: 13
- Current Prisma model count: 30
- Latest migration: `20260929100000_v13_password_reset_tokens`
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

Latest backend handoff evidence from the Database Design v1.1 alignment pass:

- `npm ci`: passed, 0 vulnerabilities; dependency deprecation warnings only.
- `npx prisma validate`: passed.
- `npm run prisma:generate`: passed.
- `npx prisma migrate deploy`: passed on the then-configured local development database; clean reset/deploy also passed on isolated `stockpilot_test`.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 4 existing `no-console` warnings in `src/server.ts`.
- `npm run build`: passed.
- `npm test`: 20 suites / 129 tests passed.
- `npm run handoff:check`: passed; reported `HANDOFF_CHECK_OK` with expected local `.env` warning.

Latest documentation governance validation on 2026-09-27:

- `npm run typecheck`: passed.
- `npm run lint`: passed with 4 existing `no-console` warnings in `src/server.ts`.
- `npm run build`: passed.
- `npm test`: 20 suites / 135 tests passed.

Latest local StockTake workflow validation on 2026-09-28:

- `npm run prisma:generate`: passed.
- `npx prisma validate`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test`: 22 suites / 150 tests passed.
- Real MySQL StockTake workflow integration: 4 tests passed with `TEST_DATABASE_URL` targeting a safe test database.

Latest local Sprint 1 backend closeout validation on 2026-09-29:

- `npm ci`: passed, 0 vulnerabilities; dependency deprecation warnings only.
- `npx prisma validate`: passed.
- `npm run prisma:generate`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test`: 25 suites / 177 tests passed.
- `npm run test:coverage`: passed, 25 suites / 177 tests.
- `npm run prisma:migrate:deploy`: passed locally against canonical app schema `stockpilot` after baselining the existing v1.1 schema history.
- `npm run prisma:migrate:deploy`: passed with `DATABASE_URL` overridden to guarded local `stockpilot_test`.
- `npm run handoff:check`: passed; reported `HANDOFF_CHECK_OK` with expected local `.env` warning.
- `npm audit`: passed, 0 vulnerabilities.

Latest CI evidence:

- Verified commit: `009fc9e8b7229fb7e7fafef8337b93afcea77e84`.
- GitHub Actions: passed.
- Database: 29 Prisma models, 12 migrations, MySQL 8.4 migration deploy passed for the verified commit. Current local closeout has 30 models and 13 migrations pending fresh exact-SHA CI.
- Tests: 20 suites / 135 tests passed.
- API compatibility: no breaking route/schema changes.
- Production: not production-observed.

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
- CI: `CI_VERIFIED` for `009fc9e8b7229fb7e7fafef8337b93afcea77e84`.
- Production: `PRODUCTION_OBSERVED` only with real production evidence.

## Known Limitations

See `docs/KNOWN_LIMITATIONS.md`.

## AI / Contributor Context

Future AI or human contributors should start with:

1. `AGENTS.md`
2. `docs/CURRENT_STATE.md`
3. `docs/ARCHITECTURE.md`
4. `docs/BUSINESS_RULES.md`
5. Relevant API, database, security, testing, and limitation docs

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
