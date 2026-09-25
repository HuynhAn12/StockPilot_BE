# Testing Guide

## Test Types

- Unit tests: pure service and utility behavior.
- API integration tests: Express/Supertest paths with mocked or controlled dependencies.
- Real MySQL integration tests: Prisma against `TEST_DATABASE_URL`.
- Concurrency tests: real MySQL races for inventory, auth refresh, pricing, and summary/idempotency behavior.

## Required Environment

Set `TEST_DATABASE_URL` to a disposable MySQL schema. Never point it at production or shared data.

```bash
set TEST_DATABASE_URL=mysql://user:password@127.0.0.1:3306/stockpilot_test
```

PowerShell example:

```powershell
$env:TEST_DATABASE_URL="mysql://user:password@127.0.0.1:3306/stockpilot_test"
```

## Verification Commands

```bash
npm ci
npx prisma validate
npm run prisma:generate
npm run prisma:migrate:deploy
npm run typecheck
npm run lint
npm run build
npm test
npm run test:coverage
npm audit
```

Focused suites:

```bash
npm test -- tests/mysql/concurrency.integration.test.ts
npm test -- tests/mysql/daily-sales-summary.integration.test.ts
npm test -- tests/mysql/pricing.integration.test.ts
npm test -- tests/mysql/idempotency.integration.test.ts
npm test -- tests/mysql/import.integration.test.ts
```

## Evidence Classification

- `IMPLEMENTED`: code exists but has not necessarily been tested in this run.
- `UNIT_TESTED`: unit tests passed in this run.
- `API_INTEGRATION_TESTED`: HTTP/API tests passed in this run.
- `MYSQL_INTEGRATION_TESTED`: real MySQL tests passed in this run.
- `CI_VERIFIED`: GitHub Actions passed for the exact commit.
- `PRODUCTION_OBSERVED`: verified on real production infrastructure.

Do not upgrade an evidence label beyond the commands actually run.
