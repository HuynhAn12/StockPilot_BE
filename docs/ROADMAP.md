# Roadmap

Status values: `DONE`, `ACTIVE`, `PLANNED`, `DEFERRED`.

## Phase 1 - Core Backend

Status: `DONE`

Evidence:

- Auth, users, categories, products, inventory, orders, returns, analytics, import/export, and historical sales modules exist.
- Unit, API integration, and MySQL integration tests cover core flows.

Notes:

- The repository is a backend handoff candidate, not production evidence.

## Phase 2 - Decision Support

Status: `DONE`

Evidence:

- Decision Engine, alerts, pricing recommendations, daily sales summaries, and assistant explanation endpoints exist.
- Tests cover deterministic engine behavior, pricing approvals, idempotency, imports, and MySQL flows.

Notes:

- Decision Engine overview scalability remains a limitation for very large catalogs.

## Phase 3 - Database Design v1.1 Core Alignment

Status: `DONE`

Evidence:

- `prisma/schema.prisma` has 29 models.
- `prisma/migrations/` has 12 migrations.
- Latest migration: `20260925213000_v12_core_architecture_alignment`.
- Foundation tables exist for StockTake, StockTakeItem, Notification, AuditLog, AiInteraction, and SystemSetting.

Notes:

- This is schema/model foundation, not full workflow implementation.

## Phase 4 - Advanced Operational Features

Status: `DEFERRED`

Evidence:

- StockTake backend workflow is implemented with store-scoped REST endpoints, lifecycle transitions, inventory adjustment completion, and focused unit/API/MySQL tests.

Planned work:

- Notification delivery and notification center
- Full audit coverage across business mutations
- SystemSetting admin API
- AI conversation history API/UI
- Batch or streaming export implementation for large catalogs

## Phase 5 - Production Hardening

Status: `PLANNED`

Planned work:

- Verify CI for final release commits
- Deployment runbooks and rollback drills
- Production monitoring and alerting
- Backup and restore drills
- Load testing for large stores
- Secrets management review
