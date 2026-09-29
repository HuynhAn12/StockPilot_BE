# Architecture

## Current Implementation

StockPilot backend is a modular monolith REST API. The application is assembled in `src/app.ts`, with feature modules under `src/modules`.

Primary layers:

- Routes map Express paths to controllers.
- Controllers validate HTTP inputs and call services.
- Services enforce business rules and transaction boundaries.
- Prisma models and transactions provide database access.

The current backend is one deployable Node.js process. There is no implemented message broker, event sourcing system, GraphQL API, CQRS split, Redis cache, or microservice decomposition.

## Runtime Components

- Backend API: Express and TypeScript
- Database: MySQL 8.4 / InnoDB
- ORM: Prisma 5
- Validation: Zod schemas per module
- Auth: JWT access tokens plus persisted hashed refresh tokens
- External AI: assistant endpoints explain authorized deterministic Decision Engine output

## Modules

- `auth`: registration, login, refresh rotation, logout, current user
- `users`: staff creation and listing
- `categories`: store-scoped category CRUD
- `products`: product and stock item management
- `inventory`: inflow, outflow, audit adjustment, balances, movements
- `orders`: order creation, confirmation, fulfillment, cancellation
- `returns`: return creation and listing
- `analytics`: dashboard summaries
- `import-export`: product import preview/commit and CSV exports
- `historical-sales`: historical sales preview/commit/listing
- `daily-sales-summary`: summary rebuild and accounting helpers
- `stock-takes`: physical count lifecycle and inventory adjustment completion
- `notifications`: per-user notification inbox listing and read state
- `decision-engine`: deterministic inventory/pricing analysis
- `alerts`: alert listing and lifecycle actions
- `pricing`: recommendation listing and decision actions
- `assistant`: read-only explanations

## Transaction Boundaries

Critical write flows use transactions where inventory, accounting, idempotency, or status changes must remain consistent. Examples include registration bootstrap, inventory ledger mutations, order confirmation/cancellation/fulfillment, returns, import commit, idempotent mutation recording, and pricing approval.

Future changes should preserve atomicity for workflows that combine status changes with stock, money, or durable idempotency state.

## Store Isolation

Store-scoped APIs derive store access from authenticated user context and RBAC middleware. Store-owned resources must be read and mutated with `storeId` checks, not by bare primary key alone.

## Decision Engine

The Decision Engine is deterministic TypeScript. It computes inventory risks, alert data, snapshots, and pricing recommendations from authorized store data and persisted configuration. AI must not replace the deterministic formulas or mutate decision outputs.

## AI Assistant

Assistant endpoints are read-only explanation wrappers around already authorized deterministic output. They must not mutate inventory, orders, returns, alerts, pricing, or recommendations, and they must minimize data sent to external AI providers.

## Database

The executable database schema is `prisma/schema.prisma`; migration history is `prisma/migrations/`. Database Design v1.2 is the target design, while the consolidated target SQL is a reference artifact rather than the migration ledger.

## Background Jobs

No continuously running background worker is part of the current app startup. Maintenance work is represented by explicit scripts such as `npm run maintenance:rebuild-summary-v10`.

## Deployment Assumptions

The app starts from `dist/server.js` after `npm run build`. Production requires explicit secrets and CORS configuration. The GitHub Actions workflow validates Prisma, applies migrations to MySQL 8.4, lints, builds, and tests.

## Target Architecture

The target remains a production-oriented modular monolith with clear module ownership, strong store isolation, deterministic decision support, and AI as an explanation layer only. Advanced operational features are planned but not fully implemented unless named in `docs/CURRENT_STATE.md`.
