# StockPilot Backend Runbook

## First-Time Local Setup

```bash
npm ci
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Use MySQL 8.4 where possible. Keep `APP_TIMEZONE=Asia/Ho_Chi_Minh`.

## Clean Database Setup

Create an empty MySQL schema, set `DATABASE_URL`, then run:

```bash
npm run prisma:migrate:deploy
npm run prisma:generate
```

Do not use `prisma db push` for shared, staging, or deployment databases.

## Test Database

Create a separate test schema and set `TEST_DATABASE_URL`. Real MySQL tests perform cleanup and must never target production or shared data.

## Deployment Migration Steps

1. Back up the target database.
2. Confirm the application build uses the same commit being deployed.
3. Run `npm ci`.
4. Run `npm run prisma:migrate:deploy`.
5. Run `npm run prisma:generate`.
6. Build with `npm run build`.
7. Start with `npm start`.
8. Check `/api/v1/health/ready`.

## Rollback Principles

Prefer forward fixes for schema changes. If application rollback is required, confirm the older application version is compatible with the already-applied migration history.

## V10 Reconciliation

Use dry-run first:

```bash
npm run maintenance:rebuild-summary-v10 -- --dry-run
npm run maintenance:rebuild-summary-v10 -- --storeId=1 --dry-run
```

Apply only after reviewing the target database:

```bash
npm run maintenance:rebuild-summary-v10 -- --storeId=1
```

Invalid `--storeId` values must fail and perform zero rebuild operations.

## Health Checks

- `GET /api/v1/health`
- `GET /api/v1/health/live`
- `GET /api/v1/health/ready`

## Failure Troubleshooting

- `DATABASE_URL` missing in production: startup exits by design.
- CORS blocked in production: set explicit `CORS_ORIGIN`.
- Prisma client mismatch: run `npm run prisma:generate`.
- MySQL unavailable: check container/service health and network binding.
- Test failures on real MySQL suites: confirm `TEST_DATABASE_URL` points to the intended disposable test schema.
- Analytics date drift: confirm `APP_TIMEZONE=Asia/Ho_Chi_Minh`.
