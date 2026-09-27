# ADR-005

Status: Accepted

## Context

The assistant feature can help explain deterministic business output but must not create hidden state changes.

## Decision

AI assistant behavior is explanation-only and read-only.

## Consequences

AI must not directly mutate inventory, orders, returns, prices, alerts, or recommendations. Context sent to AI providers must exclude secrets and unnecessary PII.
