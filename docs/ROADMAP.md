# Roadmap

Status values: `DONE`, `ACTIVE`, `PLANNED`, `DEFERRED`.

## Phase 1 - Core Backend

Status: `DONE`

Evidence:

- Auth, profile update, password recovery, users/staff update-disable, categories, products/archive semantics, inventory, orders, returns, analytics, import/export, and historical sales modules exist.
- Unit, API integration, and MySQL integration tests cover core flows.

Notes:

- The repository is a backend handoff candidate, not production evidence.
- Sprint 1 closeout added `PasswordResetToken` storage after Database Design v1.1, so the executable schema now has 30 models and 13 migrations.

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

- Database Design v1.1 alignment was completed at 29 models and 12 migrations.
- Sprint 1 password recovery now brings `prisma/schema.prisma` to 30 models and `prisma/migrations/` to 13 migrations.
- Latest migration: `20260929100000_v13_password_reset_tokens`.
- Foundation tables exist for StockTake, StockTakeItem, Notification, AuditLog, AiInteraction, and SystemSetting.

Notes:

- This is schema/model foundation, not full workflow implementation.

## Phase 4 - Advanced Operational Features

Status: `DEFERRED`

Evidence:

- StockTake backend workflow is implemented with store-scoped REST endpoints, lifecycle transitions, inventory adjustment completion, and focused unit/API/MySQL tests.
- Minimal per-user Notification Center backend is implemented with inbox listing and read-state APIs.

Planned work:

- Notification realtime delivery and broadcast/read-receipt behavior
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
