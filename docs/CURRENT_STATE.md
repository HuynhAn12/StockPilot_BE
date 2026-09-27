# Current State

This document describes the repository as inspected from the working tree. It is current implementation evidence, not a future target.

## Repository

- Active branch: `Sang`
- Package version: `v1.0.0`
- Handoff label: backend handoff candidate
- Production evidence: none observed in this repository
- CI evidence: GitHub Actions passed for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84`

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
- Target physical table count: 29
- Executable Prisma model count: 29
- Migration count: 12
- Latest migration: `20260925213000_v12_core_architecture_alignment`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.1_Complete_Design.sql` is reference only

The executable schema includes the v1.1 foundation models:

- `StockTake`
- `StockTakeItem`
- `Notification`
- `AuditLog`
- `AiInteraction`
- `SystemSetting`

## Implemented Modules

- Auth and refresh-token rotation
- Users / staff management
- Categories
- Products and stock items
- Inventory balances and stock ledger
- Orders
- Returns
- Analytics dashboard
- Import / export
- Historical sales import and listing
- Daily sales summary services
- Decision Engine
- Alerts
- Pricing recommendations
- Assistant explanations

## Deferred Features

The schema foundations exist, but these workflows are not implemented as complete production features:

- Full StockTake workflow
- Realtime notification delivery and notification center behavior
- Full audit coverage across all business mutations
- SystemSetting admin API
- AI conversation history UI/API
- Large-catalog export streaming
- Production monitoring, backup, and restore drills

## Test State

Latest verified evidence:

- `npm run typecheck`: passed
- `npm run lint`: passed with 4 existing `no-console` warnings in `src/server.ts`
- `npm run build`: passed
- `npm test`: 20 suites / 135 tests passed
- GitHub Actions: passed for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84`
- MySQL 8.4 migration deploy: passed in CI

The test suite includes unit tests, API integration tests, real MySQL integration tests, and concurrency tests. MySQL tests require `TEST_DATABASE_URL` to point at a disposable test database.

## Current Constraints

- Do not call the backend production ready from repository tests alone.
- CI is verified for commit `009fc9e8b7229fb7e7fafef8337b93afcea77e84` only.
- Do not describe v1.1 foundation tables as full feature implementations.
