# Known Limitations

This file lists confirmed current limitations only.

## Export Scalability

CSV export endpoints currently read matching rows with Prisma `findMany` and build CSV responses in memory. This is acceptable for MVP-sized datasets but is not evidence of large-catalog export support.

Affected exports:

- products
- inventory
- orders
- sales
- returns
- decision report
- alerts
- pricing recommendations

## Decision Engine Overview Scalability

The Decision Engine overview loads active SKUs for a store and analyzes them in process. It is deterministic and store-scoped, but it is not optimized for very large catalogs.

## Database Design v1.1 Deferred Features

The executable schema includes the v1.1 foundation tables, but the following workflows are intentionally not complete feature implementations:

- Full StockTake workflow is not implemented.
- Notification realtime delivery and notification center behavior are not implemented.
- Full audit coverage across all business mutations is not implemented.
- SystemSetting admin API is not implemented.
- AI conversation history UI/API is not implemented.

These foundations should not be described as production-ready feature implementations until their business workflows, authorization paths, and operational tests are added.

## Production Evidence

No production deployment, production traffic, backup/restore drill, or production observability evidence is included in this repository handoff.

Do not label the backend production ready from repository tests alone.

## CI Evidence

The repository contains a GitHub Actions workflow for MySQL 8.4, Prisma validation/generation, migration deploy, lint, build, and tests.

Local evidence is not the same as a passed GitHub Actions run for a final SHA. Mark CI as `CI_VERIFIED` only after checking the exact commit in GitHub Actions.
