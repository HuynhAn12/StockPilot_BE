# ADR-002

Status: Accepted

## Context

The executable schema is Prisma-backed and targets MySQL 8.4 / InnoDB.

## Decision

Use Prisma as the ORM and MySQL as the system of record. Use migrations in `prisma/migrations/` as the database history.

## Consequences

Historical migrations are immutable. Every schema change must create a new migration and preserve deployability from a clean database.
