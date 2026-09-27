# Security

## Authentication

- Access tokens are JWTs.
- JWT payload includes user identity, role, and store context.
- Authenticated requests check that the user is active.
- Store-scoped requests also require a valid active store context.

## Refresh Tokens

- Refresh tokens are not stored in plaintext.
- Persisted sessions store `refreshTokenHash`.
- Refresh uses token rotation.
- Reuse of a revoked refresh token is treated as a replay signal and revokes remaining active sessions for that user.

## Passwords

- Passwords are hashed before persistence.
- Passwords must never be logged or returned.
- Documentation and examples must not include real passwords.

## RBAC

Implemented roles:

- `SHOP_OWNER`
- `WAREHOUSE_STAFF`
- `ADMIN`

Store-scoped APIs are for store users. `ADMIN` must not operate store data through store-scoped APIs unless a dedicated admin API is implemented and documented.

## Store Isolation

Every tenant-owned resource must be authorized by `storeId`.

Security rule: do not fetch or mutate a store-owned entity by primary key alone.

## Request Validation

HTTP inputs use Zod schemas in module schema files. Keep validation close to the route/controller boundary and reject invalid inputs before service writes.

## Rate Limiting

`express-rate-limit` is enabled outside the test environment:

- General `/api/` requests: 300 requests per 15 minutes
- Auth login and refresh: 10 requests per minute

## CORS

Production requires an explicit `CORS_ORIGIN`. Wildcard production CORS is not acceptable.

## HTTP Hardening

The app uses `helmet` for common security headers.
JSON and URL-encoded body size is limited to `1mb`.
Request IDs are assigned for traceability.

## Sensitive Fields

The sensitive fields middleware masks cost and margin fields for `WAREHOUSE_STAFF` responses where applicable.

## Secrets

Secrets must never be committed.

Do not log:

- passwords
- JWTs
- refresh tokens
- database credentials
- API keys
- unnecessary customer PII

## AI Data Minimization

Assistant context must contain only authorized data needed to explain deterministic output.
Do not send secrets, credentials, raw tokens, or unnecessary customer PII to external AI providers.

AI is explanation-only and must not mutate business state.

## Audit Logging Principles

`AuditLog` is an append-only foundation table. Full audit coverage is not implemented yet.

When adding audit events:

- avoid secrets and tokens
- avoid unnecessary PII
- prefer compact before/after metadata
- preserve store/user context when available
