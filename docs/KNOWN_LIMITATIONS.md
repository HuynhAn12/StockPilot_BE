# Known Limitations

This file lists confirmed current limitations only.

## Export Scalability

CSV export endpoints currently read matching rows with Prisma `findMany` and build the CSV response in memory. This is acceptable for MVP-sized datasets but is not evidence of large-catalog export support. A future owner should add cursor/batched streaming exports if large stores are expected.

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

The Decision Engine overview loads active SKUs for a store and analyzes them in process. It is deterministic and store-scoped, but it is not optimized for very large catalogs. Future work can batch, paginate, or precompute overview data without changing the deterministic engine boundary.

## CI Evidence

The repository contains a GitHub Actions workflow for MySQL 8.4, Prisma validation/generation, migration deploy, lint, build, and tests. Local evidence is not the same as a passed GitHub Actions run for a final SHA. Mark CI as `CI_VERIFIED` only after checking the exact commit in GitHub Actions.

## Production Evidence

No production deployment, traffic, backup/restore drill, or observability evidence is included in this handoff. Do not label the backend production ready from repository tests alone.

## Database Design v1.1 Deferred Features

The executable schema now includes the v1.1 foundation tables, but the following features are intentionally not implemented in this phase:

- Full StockTake workflow is not implemented.
- Notification realtime delivery and notification center behavior are not implemented.
- Full audit coverage across all business mutations is not implemented.
- SystemSetting admin API is not implemented.
- AI conversation history UI/API is not implemented.

These foundations should not be described as production-ready feature implementations until their business workflows, authorization paths, and operational tests are added.
