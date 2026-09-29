# Current State

This document describes the repository as inspected from the working tree. It is current implementation evidence, not a future target.

## Repository

- Active branch: `Sang`
- Package version: `v1.0.0`
- Handoff label: backend handoff candidate
- Production evidence: none observed in this repository
- CI evidence: GitHub Actions passed for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84`; newer local changes require a fresh exact-SHA CI run before reusing `CI_VERIFIED`.

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

- Target database design: Database Design v1.1
- Executable physical table count: 30
- Executable Prisma model count: 30
- Migration count: 13
- Latest migration: `20260929100000_v13_password_reset_tokens`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.1_Complete_Design.sql` is reference only

The executable schema includes the v1.1 foundation models:

- `StockTake`
- `StockTakeItem`
- `Notification`
- `AuditLog`
- `AiInteraction`
- `SystemSetting`
- `PasswordResetToken`

## Implemented Modules

- Auth and refresh-token rotation
- Profile update and secure password recovery
- Users / staff management
- Staff update and disable
- Categories
- Products and stock items
- Inventory balances and stock ledger
- Orders
- Returns
- Analytics dashboard
- Import / export
- Historical sales import and listing
- Daily sales summary services
- StockTake workflow
- Minimal per-user Notification Center
- Decision Engine
- Alerts
- Pricing recommendations
- Assistant explanations

## Deferred Features

The schema foundations exist, but these workflows are not implemented as complete production features:

- Realtime notification delivery and broadcast/read-receipt notification behavior
- Full audit coverage across all business mutations
- SystemSetting admin API
- AI conversation history UI/API
- Large-catalog export streaming
- Production monitoring, backup, and restore drills

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
- GitHub Actions: passed for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84`
- MySQL migration deploy: passed locally against `stockpilot_dev` and guarded local `stockpilot_test` with 13 migrations applied.

The test suite includes unit tests, API integration tests, real MySQL integration tests, and concurrency tests. MySQL tests require `TEST_DATABASE_URL` to point at a disposable test database.

## Current Constraints

- Do not call the backend production ready from repository tests alone.
- CI is verified for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84` only.
- Do not describe v1.1 foundation tables as full feature implementations.
