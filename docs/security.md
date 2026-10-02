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
- Password reset success revokes active refresh sessions for the user.
- Disabling a staff user revokes active refresh sessions for that staff account.

## Passwords

- Passwords are hashed before persistence.
- Passwords must never be logged or returned.
- Documentation and examples must not include real passwords.
- Password reset tokens are generated with crypto-secure randomness.
- Password reset tokens are stored hash-only in `password_reset_tokens`, expire after 30 minutes, and are single-use.
- Forgot-password responses are generic to prevent email enumeration.
- Production HTTP password-recovery responses must not expose raw reset tokens; non-production may expose a development reset token for test workflows.

## RBAC

Implemented roles:

- `SHOP_OWNER`
- `WAREHOUSE_STAFF`
- `ADMIN`

Store-scoped APIs are for store users. `ADMIN` must not operate store data through store-scoped APIs unless a dedicated admin API is implemented and documented.

Store-scoped routes use explicit role checks where business authority differs from operational execution:

- Orders: `WAREHOUSE_STAFF` may read and fulfill; only `SHOP_OWNER` may create, confirm, or cancel.
- Inventory: `SHOP_OWNER` and `WAREHOUSE_STAFF` may read balances/movements and perform inflow, outflow, and audit adjustment.
- Returns: `WAREHOUSE_STAFF` may read returns; only `SHOP_OWNER` may create returns.
- Exports: operational product, inventory, and alert exports are available to store operators; owner-sensitive order, sales, returns, decision report, and pricing recommendation exports are `SHOP_OWNER` only.
- Payment provider credentials: only `SHOP_OWNER` may configure PayOS credentials. `WAREHOUSE_STAFF` may eventually create POS payments, but must not read or configure PayOS credentials.

## Store Isolation

Every tenant-owned resource must be authorized by `storeId`.

Security rule: do not fetch or mutate a store-owned entity by primary key alone.

Tenant hostnames use `{storeCode}.stockpilot.vn` and resolve through `Store.code`. Hostname resolution is context only; it does not authorize the request. Store APIs compare the resolved tenant store with the authenticated user's `storeId`. Unknown or inactive tenant hostnames fail closed. Legacy stored codes that used underscores can be reached by their canonical hyphen hostname through a compatibility lookup, but new registrations cannot create underscore codes.

Production store APIs must be reached as `https://{storeCode}.stockpilot.vn/api/v1/*` with the original host preserved by the reverse proxy. Store-scoped routes fail closed in production if no tenant context is resolved.

Reserved subdomains such as `www`, `api`, `admin`, `app`, `auth`, and `static` are not treated as store codes. Localhost development and tests may omit tenant hostnames. Outside production only, localhost may use `x-tenant-code` to exercise tenant resolution. Production ignores this as an authorization mechanism and must not trust arbitrary tenant headers.

Registration normalizes `Store.code` to lowercase and rejects store codes that cannot be used as DNS subdomains or that collide with reserved platform hostnames.

Legacy `Store.code` data is not renamed by Phase 3. A future optional data migration may normalize stored legacy values after collision analysis; the runtime compatibility lookup exists to avoid breaking existing tenants before that migration.

## Request Validation

HTTP inputs use Zod schemas in module schema files. Keep validation close to the route/controller boundary and reject invalid inputs before service writes.

## Rate Limiting

`express-rate-limit` is enabled outside the test environment:

- General `/api/` requests: 300 requests per 15 minutes
- Auth login, refresh, forgot-password, and reset-password: 10 requests per minute

## Account Mutation Controls

- `PATCH /auth/me` allows only current-user profile fields that exist in the current `User` schema. It does not allow role, store, active status, email, password hash, token, or admin/system field changes.
- `PATCH /users/:id` is limited to `SHOP_OWNER` callers and same-store `WAREHOUSE_STAFF` targets. Owner/admin targets, cross-store targets, role changes, store changes, email changes, and password changes are rejected or unsupported by schema.

## CORS

Production requires an explicit `CORS_ORIGIN`. Wildcard production CORS is not acceptable.

## HTTP Hardening

The app uses `helmet` for common security headers.
JSON and URL-encoded body size is limited to `1mb`.
Request IDs are assigned for traceability.

## Sensitive Fields

The sensitive fields middleware masks cost and margin fields for `WAREHOUSE_STAFF` responses where applicable.

CSV exports do not pass through JSON response masking. Export routes therefore enforce role-specific access, and product/inventory CSV generation omits cost price for `WAREHOUSE_STAFF`.

## Secrets

Secrets must never be committed.

Do not log:

- passwords
- JWTs
- refresh tokens
- database credentials
- API keys
- unnecessary customer PII

Per-store payment credentials are stored in `store_payment_configs` and encrypted with AES-256-GCM using `PAYMENT_CONFIG_ENCRYPTION_KEY`. The key must be a 32-byte base64 value or 64-character hex value in production. Payment config APIs never return raw API keys, checksum keys, or encrypted credential blobs.

## AI Data Minimization

Assistant context must contain only authorized data needed to explain deterministic output.
Do not send secrets, credentials, raw tokens, or unnecessary customer PII to external AI providers.

AI is explanation-only and must not mutate business state.

## Audit Logging Principles

`AuditLog` is an append-only foundation table. High-value mutation coverage exists for core operational workflows, including transaction-bound category changes, stock-take completion/cancelation, and payment-configuration changes. Exhaustive audit coverage across every mutation remains deferred.

When adding audit events:

- avoid secrets and tokens
- avoid unnecessary PII
- prefer compact before/after metadata
- preserve store/user context when available
