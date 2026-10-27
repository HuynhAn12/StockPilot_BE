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

The Decision Engine overview reads the latest snapshot of every active SKU of a store and filters and paginates them in memory. SKUs without a usable snapshot are still evaluated in process (read-only). This is store-scoped and no longer recomputes on every request, but it is not optimized for very large catalogs.

## Decision Engine Triggers

- The post-commit recompute queue is in-process and at-most-once: queued work is lost if the process stops. The nightly job reconciles all active SKUs, so staleness is bounded to about one day. Each instance has its own queue; duplicate work across instances is harmless because recomputation is idempotent and row-locked.
- Staleness detection (`stale`) tracks stock movements, StockItem updates, and engine config updates. Non-restockable returns and historical sales imports leave no stock movement; they rely on their post-commit triggers and the 26-hour age limit.
- Job leases and the nightly run marker are internal rows in `system_settings` (`lease:*`, `job:decision-nightly:last-run`) to avoid a schema migration. A dedicated job-lease table would be cleaner if more background jobs are added.
- The lease upsert uses the `INSERT ... AS alias ON DUPLICATE KEY UPDATE` form, which requires MySQL 8.0.19 or later (the target is 8.4).
- If the process is killed during a nightly run, the run is retried on the next night's window (its lease expires after 2 hours).

## Decision Engine Model Assumptions

- The reorder quantity assumes no open purchase orders, because purchase orders are not modelled.
- Safety stock assumes independent daily demand and a constant lead time (`SS = z · σ · √L`).
- Snapshots are append-only (one row per recomputation) and pruned after 90 days.

## Database Design v1.2 Deferred Features

The executable schema includes the v1.2 foundation tables, but the following workflows are intentionally not complete feature implementations:

- Notification realtime delivery and broadcast/read-receipt behavior are not implemented.
- Full audit coverage across all business mutations is not implemented.
- SystemSetting admin API is not implemented.
- AI conversation history UI/API is not implemented.

These foundations should not be described as production-ready feature implementations until their business workflows, authorization paths, and operational tests are added.

## POS And PayOS Runtime

Phase 3A/3B adds tenant hostname resolution and encrypted per-store PayOS credential configuration. Phase 4 adds a cash POS sale foundation. It does not implement:

- PayOS payment-link or QR creation
- PayOS webhook verification
- receipt PDF generation or printer integration
- refunds or financial corrections
- PayOS-driven order lifecycle settlement
- deferred-payment inventory timing for pending online payments
- custom store domains

Legacy `Store.code` rows that contain underscores are supported by runtime compatibility lookup from the canonical hyphen tenant slug. Phase 3 does not rename those existing rows. A future optional data migration should first check for slug collisions such as `abc_def` versus `abc-def` before normalizing stored values.

## Production Evidence

No production deployment, production traffic, backup/restore drill, or production observability evidence is included in this repository handoff.

Do not label the backend production ready from repository tests alone.

## CI Evidence

The repository contains a GitHub Actions workflow for MySQL 8.4, Prisma validation/generation, migration deploy, lint, build, and tests.

Commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84` is historical `CI_VERIFIED`: GitHub Actions passed with MySQL 8.4 migration deploy and 20 suites / 135 tests.

Sprint 1 backend closeout commit `194a3bef7ce7ffa1f9c8df7c2a274400e0368c0e` is `CI_VERIFIED`: `StockPilot Backend CI` run #27 completed successfully.

Future commits must be checked independently before carrying this label forward. CI verification is not production deployment evidence.
