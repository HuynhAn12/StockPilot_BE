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

## Database Gates

```bash
npm run prisma:migrate:deploy
npm run maintenance:rebuild-summary-v10 -- --dry-run
```

Run database gates against MySQL 8.4 with safe non-production database URLs.

## CI Gates

`.github/workflows/backend-ci.yml` defines a MySQL 8.4 GitHub Actions workflow for Prisma validation/generation, migration deploy, lint, build, and tests on `main`, `Sang`, `master`, and `fix/**` pushes plus pull requests to `main`, `Sang`, and `master`.

Do not mark `CI_VERIFIED` until the workflow passes for the exact commit being handed off.
