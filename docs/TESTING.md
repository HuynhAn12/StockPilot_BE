# Testing

Tests are evidence. Do not claim a stronger evidence level than the commands actually run.

## Test Types

- Unit tests: pure services, utilities, and deterministic business logic.
- API integration tests: Express/Supertest coverage of routes and middleware behavior.
- MySQL integration tests: Prisma against `TEST_DATABASE_URL`.
- Concurrency tests: real MySQL race and serialization behavior.

## Required Environment

`TEST_DATABASE_URL` must point to a disposable test database. Never point it at production or shared development data.

PowerShell example:

```powershell
$env:TEST_DATABASE_URL="mysql://user:password@127.0.0.1:3306/stockpilot_test"
```

## Canonical Verification Commands

```bash
npm ci
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm test
```

For database changes, also run:

```bash
npx prisma validate
npx prisma migrate deploy
```

Additional useful commands:

```bash
npm run test:coverage
npm run handoff:check
npm audit
```

Focused MySQL suites:

```bash
npm test -- tests/mysql/concurrency.integration.test.ts
npm test -- tests/mysql/daily-sales-summary.integration.test.ts
npm test -- tests/mysql/pricing.integration.test.ts
npm test -- tests/mysql/idempotency.integration.test.ts
npm test -- tests/mysql/import.integration.test.ts
npm test -- tests/mysql/schema-alignment.integration.test.ts
```

## CI Checks

`.github/workflows/backend-ci.yml` runs on MySQL 8.4 and performs:

- `npm ci`
- `npx prisma validate`
- `npx prisma generate`
- `npx prisma migrate deploy`
- `npm run lint`
- `npm run build`
- `npm test`

Mark `CI_VERIFIED` only after the workflow passes for the exact commit.

## Evidence Labels

- `IMPLEMENTED`: code exists, but was not necessarily tested in the current run.
- `UNIT_TESTED`: relevant unit tests passed in the current run.
- `API_INTEGRATION_TESTED`: relevant API integration tests passed in the current run.
- `MYSQL_INTEGRATION_TESTED`: relevant real MySQL tests passed in the current run.
- `CI_VERIFIED`: GitHub Actions passed for the exact commit.
- `PRODUCTION_OBSERVED`: verified on real production infrastructure.

## Test Integrity Rules

Do not:

- delete tests to pass CI
- weaken assertions to pass CI
- add `test.skip` or `describe.skip` as a workaround
- leave `test.only` or `describe.only`
- bypass MySQL safety guards

If a test is wrong, document the reason and update it with matching source and business-rule changes.
