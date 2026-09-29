# Verification Notes

This file records the expected verification gates for the handoff candidate. Treat chat/final reports and CI logs as the source for exact pass/fail evidence for a specific commit.

## Local Gates

```bash
npm ci
npx prisma validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm test
npm run test:coverage
npm audit
```

Latest local Sprint 1 backend closeout evidence on 2026-09-29:

- `npm ci`: passed, 0 vulnerabilities; dependency deprecation warnings only.
- `npx prisma validate`: passed.
- `npm run prisma:generate`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test`: passed, 25 suites / 177 tests.
- `npm run test:coverage`: passed, 25 suites / 177 tests.
- `npm run handoff:check`: passed with `HANDOFF_CHECK_OK`; warned that local `.env` exists and must remain untracked.
- `npm audit`: passed, 0 vulnerabilities.

## Database Gates

```bash
npm run prisma:migrate:deploy
npm run maintenance:rebuild-summary-v10 -- --dry-run
```

Run database gates against MySQL 8.4 with safe non-production database URLs.

Latest local database evidence on 2026-09-29:

- `npm run prisma:migrate:deploy`: passed against local `stockpilot_dev`.
- `npm run prisma:migrate:deploy`: passed with `DATABASE_URL` overridden to guarded local `stockpilot_test`.

## CI Gates

`.github/workflows/backend-ci.yml` defines a MySQL 8.4 GitHub Actions workflow for Prisma validation/generation, migration deploy, lint, build, and tests on `main`, `Sang`, `master`, and `fix/**` pushes plus pull requests to `main`, `Sang`, and `master`.

Do not mark `CI_VERIFIED` until the workflow passes for the exact commit being handed off.

Current Sprint 1 backend closeout changes have not yet been exact-SHA CI verified in this repository.
