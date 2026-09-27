# ADR-003

Status: Accepted

## Context

Inventory risk, alerts, snapshots, and pricing recommendations need repeatable behavior.

## Decision

Keep the Decision Engine deterministic in TypeScript.

## Consequences

AI may explain outputs, but it must not replace formulas, thresholds, persisted decisions, or authorization checks.
