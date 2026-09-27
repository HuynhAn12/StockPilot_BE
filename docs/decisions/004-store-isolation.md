# ADR-004

Status: Accepted

## Context

StockPilot uses a shared database and shared schema for multiple stores.

## Decision

Store-owned data must be scoped and authorized by `storeId`.

## Consequences

Queries and mutations for tenant-owned resources must include store ownership checks. Primary-key-only access is not sufficient for store-owned resources.
