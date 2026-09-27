# StockPilot Production Checklist

Use this checklist before any production launch or production-impacting change. Do not mark production-ready unless the evidence is from the target environment.

## Environment

- [ ] CI exact commit verified.
- [ ] `NODE_ENV=production`.
- [ ] Production env validated.
- [ ] `DATABASE_URL` points to the approved MySQL 8.4 production database.
- [ ] Secrets configured through the deployment secret manager.
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are unique, random, at least 32 characters, and stored only in the deployment secret manager.
- [ ] `CORS_ORIGIN` is explicit and does not include `*`.
- [ ] HTTPS/TLS configured at the platform or proxy.
- [ ] `APP_TIMEZONE=Asia/Ho_Chi_Minh`.
- [ ] `LOG_LEVEL` is set to `info` or stricter for production.
- [ ] `TRUST_PROXY` matches the ingress/load balancer topology.
- [ ] Rate limit env values are reviewed for the deployment tier.

## Build And Release

- [ ] `npm ci` passes from a clean checkout.
- [ ] `npx prisma validate` passes.
- [ ] `npm run prisma:generate` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `npm run security:audit` passes or has an approved exception.
- [ ] `npm run handoff:check` passes.
- [ ] Docker image builds from the checked-in `Dockerfile`, if deploying with containers.

## Database

- [ ] Production database backup completed and restore path identified.
- [ ] Restore procedure tested on a non-production database.
- [ ] `npm run prisma:migrate:deploy` tested on staging with the same commit.
- [ ] Migrations deployed to the target environment.
- [ ] Migration history matches `prisma/migrations`.
- [ ] No reviewed historical migration was edited.
- [ ] Rollback compatibility is reviewed before deploy.

## Runtime

- [ ] `/api/v1/health/live` returns 2xx after startup.
- [ ] `/api/v1/health/ready` returns 2xx only when MySQL is reachable.
- [ ] SIGTERM graceful shutdown is exercised in staging.
- [ ] Request logs include request id, method, path, status, latency, and authenticated user/store where available.
- [ ] Error responses do not expose stack traces or Prisma internals in production.
- [ ] Logs are collected by the platform and searchable by request id.
- [ ] Logs verified in the target environment.
- [ ] Error redaction verified in the target environment.
- [ ] Smoke test passed in the target environment.
- [ ] Load test passed on staging.

## Security

- [ ] `.env` files are not included in the image or repository.
- [ ] Auth and general rate limits are enabled.
- [ ] CORS is verified from the frontend origin and blocked from an unapproved origin.
- [ ] Secrets rotation procedure is documented for the deployment platform.
- [ ] Backup files are encrypted or stored only in approved restricted storage.

## Incident Readiness

- [ ] On-call owner knows the health endpoints and rollback procedure.
- [ ] Backup and restore commands are validated on a non-production database.
- [ ] Database outage, high error rate, high latency, and auth incident steps are reviewed.
- [ ] Rollback procedure verified.
- [ ] Monitoring configured.
- [ ] Production traffic observed before any `PRODUCTION_OBSERVED` claim.
- [ ] Production evidence will be recorded in `docs/HANDOFF.md` only after real observation.
