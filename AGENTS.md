# StockPilot AI Contributor Guide

## Project

StockPilot is a Smart Inventory and Pricing Decision Support System.

Backend stack:

- Node.js 24
- Express
- TypeScript
- Prisma
- MySQL 8.4 / InnoDB
- Zod
- Jest / Supertest

Architecture:

- Modular monolith
- REST API
- Controller -> Service -> Prisma data access

## Mandatory Reading Before Coding

Read these first, then inspect the real source code before editing:

1. `docs/CURRENT_STATE.md`
2. `docs/ARCHITECTURE.md`
3. `docs/BUSINESS_RULES.md`
4. `docs/database.md` for database changes
5. `docs/api.md` for API changes
6. `docs/security.md` for auth, authorization, logging, AI, or data exposure changes
7. `docs/KNOWN_LIMITATIONS.md`

## Source Of Truth

- Target architecture: architecture and roadmap docs in `docs/`
- Target database: Database Design v1.2
- Executable database schema: `prisma/schema.prisma`
- Migration history: `prisma/migrations/`
- Current implementation: `src/**`
- Tests: `tests/**`
- Consolidated target SQL: `prisma/StockPilot_MySQL8_Target_v1.2_Complete_Design.sql` as reference only

If sources conflict, report the conflict instead of guessing.

## Architecture Rules

Do not add these unless the task explicitly requires them:

- microservices
- Kafka
- RabbitMQ
- Redis
- MongoDB
- GraphQL
- CQRS
- event sourcing

Controllers handle HTTP concerns only.
Services own business logic.
Prisma is the data access layer.

## Store Isolation

Every tenant-owned resource must be verified against `storeId`.
Do not fetch a store-owned entity by `id` alone when authorizing or mutating it.

## Database Rules

- Historical migrations are immutable.
- Every schema change needs a new migration.
- Money uses `DECIMAL(15,2)`.
- Do not use float/double for money.
- Critical writes use transactions.
- Inventory cannot become negative.
- `reservedQuantity <= quantity`.

## Inventory

Every successful inventory mutation must create a `StockMovement`.
`InventoryBalance` and `StockMovement` must remain consistent.

## Orders

Fulfillment and inventory deduction must be atomic.
`OrderItem` uses sale-time snapshots for SKU, name, price, cost, refundable amount, and quantity.

## Returns

Returned quantity cannot exceed sold quantity.
Refunds are based on stored snapshot/refundable values.
Restockable returns must go through the inventory ledger.

## Decision Engine

The Decision Engine is deterministic TypeScript.
AI must not replace formulas, thresholds, or persisted deterministic decisions.

## AI Assistant

AI may only:

- explain authorized data
- summarize authorized data
- explain recommendations

AI must not directly mutate:

- inventory
- orders
- returns
- prices
- alerts
- recommendations

Never send or log:

- passwords
- JWTs
- refresh tokens
- database credentials
- unnecessary customer PII

## Backward Compatibility

Do not break existing API contracts unless the task explicitly requires it and the change is documented.
Compatibility aliases must remain unless a migration plan removes them.

## Tests

Before finishing normal backend changes, run:

```bash
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm test
```

For database changes, also run:

```bash
npx prisma validate
npx prisma migrate deploy
```

Do not delete tests, weaken assertions, add `test.skip`, or add `test.only` just to make CI pass.

## Scope Control

- Do not edit unrelated code.
- Do not major-upgrade dependencies without explicit approval.
- Do not rename modules in bulk.
- Do not perform broad cleanup outside the task scope.
- Do not edit Proposal files.
- Do not rewrite historical migrations.

## Documentation Updates

After an architecture, business-rule, schema, API, or security change, update the relevant docs in the same change.

## Agent Workflow

Task -> read `AGENTS.md` -> read context docs -> inspect source -> produce a short implementation plan -> implement a small change -> run tests -> review git diff -> update docs -> report.

If a conflict with architecture or business rules appears, stop and report instead of improvising.

## Final Report

Report:

- files changed
- migrations
- tests
- compatibility impact
- deferred work
- risks
