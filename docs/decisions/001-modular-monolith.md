# ADR-001

Status: Accepted

## Context

StockPilot currently ships as one TypeScript backend with feature modules under `src/modules`.

## Decision

Use a modular monolith with REST endpoints and clear controller/service/data-access boundaries.

## Consequences

The codebase stays simpler to test and deploy. Future agents must not introduce microservices or distributed messaging without an explicit architecture task.
