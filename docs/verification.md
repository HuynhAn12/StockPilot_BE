# StockPilot Backend Verification Notes

Updated: 2026-09-23
Branch: `codex/stockpilot-backend-hardening`

## What changed

- CI now sets test-safe environment variables at job scope, so Prisma validate/generate, migration deploy, build, and tests all receive `DATABASE_URL` and JWT secrets.
- Added baseline Prisma migration: `prisma/migrations/20260923150000_baseline/migration.sql`.
- Production startup configuration now requires explicit `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, and non-wildcard `CORS_ORIGIN`.
- Readiness no longer returns raw database error messages.
- Auth middleware checks the current user and store state on each request, so locked users and inactive stores are rejected even if the JWT is otherwise valid.
- Store-scoped shop APIs reject `ADMIN` users instead of allowing store selection through `x-store-id` or query parameters.
- Return creation rejects duplicate `orderItemId` lines when `isRestockable` conflicts.

## Local gates

- `npx prisma validate` with explicit `DATABASE_URL`: passed.
- `npm run build`: passed.
- `npm test`: passed, 7 suites and 21 tests.
- Production env guard with missing secrets/database URL: failed fast as expected.
- `npx prisma migrate deploy`: not completed locally because MySQL was not reachable at `127.0.0.1:3306`.

## Migration policy

- Use `npx prisma migrate deploy` for shared, staging, and production databases.
- Do not use `prisma db push` against shared, staging, or production databases.
- Back up any database that may already contain data before applying migrations.
- Compare live schema before treating the baseline migration as safe for a non-empty database.

## Remaining gates

- Run `npx prisma migrate deploy` against a real MySQL 8.x database.
- Run true MySQL-backed integration tests for concurrent order confirmation, inventory audit, and returns.
- Capture dashboard/list/order performance numbers on a documented dataset before claiming the proposal p95 target.
