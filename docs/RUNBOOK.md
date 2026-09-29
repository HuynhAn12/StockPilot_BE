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

Local database convention:

- Use `stockpilot` as the single app/development schema in `DATABASE_URL`.
- Use `stockpilot_test` only for automated tests in `TEST_DATABASE_URL`.
- Do not point destructive test commands at `stockpilot`.

## Clean Database Setup

Create an empty MySQL schema, set `DATABASE_URL`, then run:

```bash
npm run prisma:migrate:deploy
npm run prisma:generate
```

Do not use `prisma db push` for shared, staging, or deployment databases.

## Production Configuration

Production startup fails fast when required configuration is missing or unsafe. Required production values:

- `DATABASE_URL`
- `JWT_SECRET` with a non-placeholder value of at least 32 characters
- `JWT_REFRESH_SECRET` with a non-placeholder value of at least 32 characters
- `CORS_ORIGIN` with explicit origins and no wildcard
- `APP_TIMEZONE=Asia/Ho_Chi_Minh`

Set `TRUST_PROXY` to match the ingress topology. Use `false` when the app receives direct client connections, `true` only behind a trusted proxy chain, or a hop count such as `1` when the platform requires it.

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

For container deployments:

```bash
docker build -t stockpilot-backend:<commit-sha> .
docker run --env-file .env -p 5000:5000 stockpilot-backend:<commit-sha>
```

The image runs `node dist/server.js` as a non-root user and does not copy `.env` files.

## Rollback Principles

Prefer forward fixes for schema changes. If application rollback is required, confirm the older application version is compatible with the already-applied migration history.

Application rollback:

1. Confirm the target rollback commit and image digest.
2. Confirm no incompatible migration was applied after that commit.
3. Switch traffic to the previous image or process release.
4. Check `/api/v1/health/live` and `/api/v1/health/ready`.
5. Search logs by request id for new 5xx errors.

Database restore is destructive and must be treated as an incident action, not a normal rollback. Use it only with approval and after preserving the current database state.

## Backup And Restore

Preferred production backup is the managed database provider's snapshot/PITR feature. The local scripts are for operator-controlled MySQL dump workflows and non-production restore rehearsal.

Create a backup:

```bash
npm run db:backup -- --output=backups/stockpilot.sql
```

Verify the backup artifact exists and is non-empty before using it for a recovery plan:

```bash
test -s backups/stockpilot.sql
```

Restore to a non-production database:

```bash
npm run db:restore -- --file=backups/stockpilot.sql
```

Restore drill:

1. Point `DATABASE_URL` at a disposable database whose name includes `restore`, `staging`, `stage`, `dev`, or `test`.
2. Run the restore command.
3. Run `npm run prisma:migrate:deploy`.
4. Start the app and check `/api/v1/health/ready`.
5. Run the smoke tests approved for that environment.

The restore script refuses target database names that do not look non-production. For an approved production restore, preserve the current database first, set `ALLOW_PRODUCTION_RESTORE=true`, and pass `--confirm-production-restore`.

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

`/api/v1/health/live` proves the HTTP process is up. `/api/v1/health/ready` performs a MySQL `SELECT 1` and returns non-2xx when the database is unavailable.

## Logging And Observability

Production logs are JSON and include timestamp, level, message, request id, method, path, status code, latency, user id, and store id when available. Request bodies, authorization headers, cookies, tokens, passwords, database URLs, and secrets are not logged by default.

Use the `x-request-id` response header to correlate client reports with server logs.

## Incident Response

Database unavailable:

1. Confirm `/api/v1/health/ready` is returning 503.
2. Check MySQL health, network path, credentials, and connection limits.
3. Confirm no migration is currently running.
4. Keep the application out of rotation until readiness recovers.

Startup failure:

1. Inspect startup logs for environment validation or database connection failure.
2. Verify required production env keys and `CORS_ORIGIN`.
3. Run `npx prisma validate` and `npm run prisma:generate` on the same commit.

High error rate:

1. Filter logs by `level=error`.
2. Group by route, status code, and request id.
3. Roll back application code only after confirming migration compatibility.

High latency:

1. Sort request logs by `latencyMs`.
2. Compare affected paths with database health and pool pressure.
3. Reduce traffic or scale horizontally only after confirming rate limits and proxy settings.

Auth or token incident:

1. Rotate `JWT_SECRET` and `JWT_REFRESH_SECRET` through the deployment secret manager.
2. Restart all app instances.
3. Expect existing sessions to be invalidated.

## Failure Troubleshooting

- `DATABASE_URL` missing in production: startup exits by design.
- CORS blocked in production: set explicit `CORS_ORIGIN`.
- Prisma client mismatch: run `npm run prisma:generate`.
- MySQL unavailable: check container/service health and network binding.
- Test failures on real MySQL suites: confirm `TEST_DATABASE_URL` points to the intended disposable test schema.
- Analytics date drift: confirm `APP_TIMEZONE=Asia/Ho_Chi_Minh`.
