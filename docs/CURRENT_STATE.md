# Current State

This document describes the repository as inspected from the working tree. It is current implementation evidence, not a future target.

## Repository

- Active branch: `Sang`
- Package version: `v1.0.0`
- Sprint 1 Backend: `BACKEND_SPRINT_1_COMPLETE`
- Handoff label: backend handoff candidate
- Production evidence: none observed in this repository
- CI evidence: GitHub Actions `StockPilot Backend CI` run #27 passed for exact commit `194a3bef7ce7ffa1f9c8df7c2a274400e0368c0e`.

## Stack

- Node.js 24 recommended by docs and CI
- Express
- TypeScript
- Prisma 5.22
- MySQL 8.4 / InnoDB
- Zod validation
- JWT access tokens and hashed refresh tokens
- Jest and Supertest

## Architecture

- Modular monolith backend
- REST API mounted under `/api/v1`
- Controllers handle HTTP request/response work
- Services hold business logic
- Prisma schema and client provide database access
- Middleware provides request IDs, security headers, CORS, rate limiting, auth, RBAC, error handling, and sensitive field masking

## Database State

- Target database design: Database Design v1.2
- Executable physical table count: 31
- Executable Prisma model count: 31
- Migration count: 14
- Latest migration: `20261001120000_v14_store_payment_configs`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.2_Complete_Design.sql` is reference only

The executable schema includes the v1.2 foundation models:

- `StockTake`
- `StockTakeItem`
- `Notification`
- `AuditLog`
- `AiInteraction`
- `SystemSetting`
- `PasswordResetToken`
- `StorePaymentConfig`

## Implemented Modules

- Auth and refresh-token rotation
- Profile update and secure password recovery
- Users / staff management
- Staff update and disable
- Categories
- Products and stock items
- Inventory balances and stock ledger with explicit owner/staff inventory RBAC
- Orders with explicit owner/staff RBAC split for read, create, confirm, fulfill, and cancel
- Returns with owner-only creation and owner/staff read access
- Analytics dashboard
- Import / export with role-gated CSV exports for owner-sensitive business data
- Historical sales import and listing
- Daily sales summary services
- StockTake workflow
- Minimal per-user Notification Center
- Decision Engine
- Alerts
- Pricing recommendations
- Assistant explanations
- Phase 3A tenant hostname resolution for `{storeCode}.stockpilot.vn`
- Phase 3B owner-only PayOS credential configuration foundation

## Deferred Features

The schema foundations exist, but these workflows are not implemented as complete production features:

- Realtime notification delivery and broadcast/read-receipt notification behavior
- Full audit coverage across all business mutations
- SystemSetting admin API
- AI conversation history UI/API
- Large-catalog export streaming
- Production monitoring, backup, and restore drills
- POS sale workflow, payment records, PayOS payment-link creation, webhook confirmation, refunds, and receipts

## Test State

Latest verified evidence:

- `npm run prisma:generate`: passed
- `npx prisma validate`: passed
- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm run build`: passed
- Focused Sprint 1 closeout tests: `npm test -- tests/auth.test.ts tests/api-integration.test.ts tests/order-flow.test.ts` passed, 3 suites / 37 tests.
- `npm test`: 25 suites / 177 tests passed, including unit, API integration, real MySQL integration, and concurrency tests.
- `npm run test:coverage`: passed, 25 suites / 177 tests.
- `npm run handoff:check`: passed with `HANDOFF_CHECK_OK` and the expected local `.env` warning.
- `npm audit`: passed with 0 vulnerabilities.
- GitHub Actions: `StockPilot Backend CI` run #27 passed for commit `194a3bef7ce7ffa1f9c8df7c2a274400e0368c0e`.
- MySQL migration deploy: passed locally against canonical app schema `stockpilot` and guarded local test schema `stockpilot_test` with 13 migrations applied.

The test suite includes unit tests, API integration tests, real MySQL integration tests, and concurrency tests. MySQL tests require `TEST_DATABASE_URL` to point at a disposable test database.

## Current Constraints

- Do not call the backend production ready from repository tests alone.
- Sprint 1 backend is complete and CI verified, but production deployment has not been observed.
- Do not describe v1.2 foundation tables as full feature implementations.
