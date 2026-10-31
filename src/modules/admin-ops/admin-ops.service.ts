import crypto from 'crypto';
import { Prisma, PrismaClient, SupportTicketPriority } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { env } from '../../config/env';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { JOB_STATE_KEYS } from '../../common/services/job-state.service';
import {
  LOGIN_AUDIT_ENTITY,
  LOGIN_BLOCKED_ACTION,
  LOGIN_FAILED_ACTION,
  LOGIN_LOCK_CLEARED_ACTION,
  LoginGuardService,
} from '../../common/services/login-guard.service';
import { OpsSettingKey, OpsSettingsService } from '../../common/services/ops-settings.service';
import {
  SYSTEM_SETTING_KEYS,
  SystemSettingKey,
  SystemSettingsService,
} from '../../common/services/system-settings.service';
import { addBusinessDays, businessDateRangeToUtc, toBusinessDateKey } from '../../common/utils/business-date';
import { comparePassword } from '../../common/utils/password';
import { isDecisionSchedulerEnabled } from '../decision-engine/decision-scheduler';
import { DecisionJobsService } from '../decision-engine/decision-jobs.service';
import {
  BroadcastInput,
  GrowthQuery,
  LoginFailureQuery,
  PaymentHealthQuery,
  SettingHistoryQuery,
  RetentionQuery,
  SupportSlaQuery,
  TransferOwnerInput,
} from './admin-ops.schema';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const DECISION_NIGHTLY_JOB = 'decision-nightly';
const DECISION_RECALC_LEASE_PREFIX = 'lease:decision-recalc:';
const SLA_SAMPLE_LIMIT = 5000;
const OVERDUE_SCAN_LIMIT = 500;
const OVERDUE_RESULT_LIMIT = 50;
const DORMANT_SCAN_LIMIT = 5000;
const DORMANT_RESULT_LIMIT = 50;
const BROADCAST_MAX_RECIPIENTS = 20000;
const BROADCAST_CHUNK = 500;
const SETTING_AUDIT_ACTIONS = ['SYSTEM_SETTING_UPDATED', 'SYSTEM_SETTING_RESTORED'];
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Nearest-rank percentile of an unsorted list; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE_MS));
}

function asObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Platform-operations features for admins (jobs, security, payment health, support SLA, growth,
 * settings history, owner transfer, announcements).
 *
 * Privacy rule (docs: ADMIN_UPGRADE_PLAN.md): admins only see platform-level counts, statuses and
 * timestamps — never shop revenue, payment amounts, AI conversation content or cost prices.
 */
export class AdminOpsService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly loginGuard: LoginGuardService = new LoginGuardService(prisma),
    private readonly decisionJobs: Pick<DecisionJobsService, 'recalculateStore'> = new DecisionJobsService(prisma)
  ) {}

  // ---------------------------------------------------------------------------
  // A2 — Background jobs
  // ---------------------------------------------------------------------------

  async getJobs(now: Date = new Date()) {
    const nightlyKeys = [
      JOB_STATE_KEYS.lastRun(DECISION_NIGHTLY_JOB),
      JOB_STATE_KEYS.lastFailure(DECISION_NIGHTLY_JOB),
      JOB_STATE_KEYS.lease(DECISION_NIGHTLY_JOB),
    ];
    const [rows, recalcLeases] = await Promise.all([
      this.prisma.systemSetting.findMany({ where: { key: { in: nightlyKeys } }, select: { key: true, valueJson: true, updatedAt: true } }),
      this.prisma.systemSetting.findMany({
        where: { key: { startsWith: DECISION_RECALC_LEASE_PREFIX } },
        select: { key: true, valueJson: true },
      }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const lastRunRow = byKey.get(nightlyKeys[0]);
    const lastRun: (Record<string, unknown> & { finishedAt: Date }) | null = lastRunRow
      ? { ...asObject(lastRunRow.valueJson), finishedAt: lastRunRow.updatedAt }
      : null;

    const failureValue = asObject(byKey.get(nightlyKeys[1])?.valueJson);
    const lastFailure =
      failureValue && typeof failureValue.at === 'string'
        ? { at: new Date(failureValue.at), message: String(failureValue.message ?? '') }
        : null;

    const leaseExpiresAt = Number(asObject(byKey.get(nightlyKeys[2])?.valueJson)?.expiresAt ?? 0);
    const running = leaseExpiresAt > now.getTime();

    let status: 'RUNNING' | 'FAILED' | 'SUCCESS' | 'NEVER_RUN' = 'NEVER_RUN';
    if (running) status = 'RUNNING';
    else if (lastFailure && (!lastRun || lastFailure.at > lastRun.finishedAt)) status = 'FAILED';
    else if (lastRun) status = 'SUCCESS';

    const enabled = isDecisionSchedulerEnabled();
    const yesterdayKey = addBusinessDays(toBusinessDateKey(now), -1);
    const lastBusinessDate = typeof lastRun?.businessDate === 'string' ? lastRun.businessDate : null;
    const stale = enabled && !running && (!lastBusinessDate || lastBusinessDate < yesterdayKey);

    const runningStoreRecalculations = recalcLeases
      .filter((row) => Number(asObject(row.valueJson)?.expiresAt ?? 0) > now.getTime())
      .map((row) => Number(row.key.slice(DECISION_RECALC_LEASE_PREFIX.length)))
      .filter((id) => Number.isInteger(id) && id > 0);

    return [
      {
        name: DECISION_NIGHTLY_JOB,
        label: 'Decision Engine — tính lại hằng đêm',
        schedule: { enabled, nightlyHour: env.DECISION_NIGHTLY_HOUR, timeZone: env.APP_TIMEZONE },
        status,
        stale,
        lastRun,
        lastFailure,
        runningStoreRecalculations,
      },
    ];
  }

  /** Recomputes Decision Engine results for one store (no business data is edited by the admin). */
  async runDecisionForStore(storeId: number, actorUserId: number, meta: RequestMeta = {}) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, isActive: true } });
    if (!store) throw new NotFoundError('Không tìm thấy cửa hàng');
    if (!store.isActive) throw new ConflictError('Cửa hàng đang bị tạm ngưng, không thể tính lại');

    const startedAt = Date.now();
    const result = (await this.decisionJobs.recalculateStore(storeId)) as Record<string, unknown>;
    const summary = {
      processed: Number(result.processed ?? 0),
      successCount: Number(result.successCount ?? 0),
      failureCount: Number(result.failureCount ?? 0),
      remaining: Number(result.remaining ?? 0),
      durationMs: Date.now() - startedAt,
    };

    await AuditLogService.create(this.prisma, {
      storeId,
      userId: actorUserId,
      action: 'DECISION_RECALC_TRIGGERED_BY_ADMIN',
      entityType: 'JOB',
      entityId: `${DECISION_NIGHTLY_JOB}:store:${storeId}`,
      afterJson: summary,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { storeId, storeName: store.name, ...summary };
  }

  // ---------------------------------------------------------------------------
  // A1 — Login security
  // ---------------------------------------------------------------------------

  async getLoginFailures(query: LoginFailureQuery, now: Date = new Date()) {
    const since = new Date(now.getTime() - query.hours * HOUR_MS);
    const where = { action: LOGIN_FAILED_ACTION, entityType: LOGIN_AUDIT_ENTITY, createdAt: { gte: since } };

    const [totalFailures, blockedAttempts, byIp, byAccount, lockout] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.count({ where: { ...where, action: LOGIN_BLOCKED_ACTION } }),
      this.prisma.auditLog.groupBy({
        by: ['ipAddress'],
        where,
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { ipAddress: 'desc' } },
        take: query.limit,
      }),
      this.prisma.auditLog.groupBy({
        by: ['entityId'],
        where,
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { entityId: 'desc' } },
        take: query.limit,
      }),
      OpsSettingsService.get('ops.security.loginLockout', this.prisma),
    ]);

    const accountKeys = byAccount.map((row) => row.entityId).filter((key): key is string => Boolean(key));
    const latestRows = accountKeys.length
      ? await this.prisma.auditLog.findMany({
          where: { ...where, entityId: { in: accountKeys } },
          orderBy: { createdAt: 'desc' },
          take: accountKeys.length * 20,
          select: {
            entityId: true,
            afterJson: true,
            user: { select: { id: true, fullName: true, role: true, isActive: true, storeId: true } },
          },
        })
      : [];
    const latestByKey = new Map<string, (typeof latestRows)[number]>();
    for (const row of latestRows) {
      if (row.entityId && !latestByKey.has(row.entityId)) latestByKey.set(row.entityId, row);
    }

    const accounts = await Promise.all(
      byAccount
        .filter((row) => row.entityId)
        .map(async (row) => {
          const latest = latestByKey.get(row.entityId!);
          const user = latest?.user ?? null;
          const state = await this.loginGuard.getLockState(row.entityId!, user?.id, now).catch(() => null);
          return {
            accountKey: row.entityId!,
            emailMasked: String(asObject(latest?.afterJson ?? null)?.emailMasked ?? '***'),
            user,
            failures: row._count._all,
            lastFailedAt: row._max.createdAt,
            locked: state?.locked ?? false,
            retryAfterMinutes: state?.locked ? state.retryAfterMinutes : 0,
          };
        })
    );

    return {
      windowHours: query.hours,
      lockout,
      totalFailures,
      blockedAttempts,
      byIp: byIp.map((row) => ({ ipAddress: row.ipAddress, failures: row._count._all, lastFailedAt: row._max.createdAt })),
      byAccount: accounts,
    };
  }

  /** Lifts a temporary login lock early. To lock an account permanently use PATCH /admin/users/:id/status. */
  async clearLoginLock(accountKey: string, reason: string, actorUserId: number, meta: RequestMeta = {}) {
    await AuditLogService.create(this.prisma, {
      userId: actorUserId,
      action: LOGIN_LOCK_CLEARED_ACTION,
      entityType: LOGIN_AUDIT_ENTITY,
      entityId: accountKey,
      afterJson: { reason },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { accountKey, cleared: true };
  }

  // ---------------------------------------------------------------------------
  // A3 — Payment health (counts and timestamps only, never amounts)
  // ---------------------------------------------------------------------------

  async getPaymentHealth(query: PaymentHealthQuery, now: Date = new Date()) {
    const pendingMinutes = query.pendingMinutes ?? (await OpsSettingsService.get('ops.payments.pendingAlertMinutes', this.prisma));
    const cutoff = new Date(now.getTime() - pendingMinutes * MINUTE_MS);

    const [stores, configs, stuck, lastPaid] = await Promise.all([
      this.prisma.store.findMany({ select: { id: true, name: true, code: true, isActive: true }, orderBy: { id: 'asc' }, take: 5000 }),
      this.prisma.storePaymentConfig.findMany({ where: { provider: 'PAYOS' }, select: { storeId: true, isActive: true, configuredAt: true } }),
      this.prisma.payment.groupBy({
        by: ['storeId'],
        where: { provider: 'PAYOS', status: 'PENDING', createdAt: { lt: cutoff } },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      this.prisma.payment.groupBy({
        by: ['storeId'],
        where: { provider: 'PAYOS', status: 'PAID' },
        _max: { paidAt: true },
      }),
    ]);

    const configByStore = new Map(configs.map((c) => [c.storeId, c]));
    const stuckByStore = new Map(stuck.map((s) => [s.storeId, s]));
    const paidByStore = new Map(lastPaid.map((p) => [p.storeId, p._max.paidAt]));

    const items = stores
      .map((store) => {
        const config = configByStore.get(store.id);
        const stuckRow = stuckByStore.get(store.id);
        return {
          storeId: store.id,
          name: store.name,
          code: store.code,
          storeActive: store.isActive,
          payosConfigured: Boolean(config?.isActive),
          payosConfiguredAt: config?.configuredAt ?? null,
          stuckPendingCount: stuckRow?._count._all ?? 0,
          oldestStuckAt: stuckRow?._min.createdAt ?? null,
          lastPaidAt: paidByStore.get(store.id) ?? null,
        };
      })
      .filter((item) => item.payosConfigured || item.stuckPendingCount > 0 || item.lastPaidAt)
      .sort((a, b) => b.stuckPendingCount - a.stuckPendingCount || a.name.localeCompare(b.name));

    return {
      pendingMinutes,
      summary: {
        storesConfigured: items.filter((i) => i.payosConfigured).length,
        storesWithStuckPayments: items.filter((i) => i.stuckPendingCount > 0).length,
        totalStuckPayments: items.reduce((sum, i) => sum + i.stuckPendingCount, 0),
      },
      items,
      limitations: ['Chưa thống kê webhook lỗi/sai chữ ký: hệ thống hiện chưa lưu các webhook bị từ chối.'],
    };
  }

  // ---------------------------------------------------------------------------
  // B4 — Support SLA
  // ---------------------------------------------------------------------------

  async getSupportSla(query: SupportSlaQuery, now: Date = new Date()) {
    const to = query.to ?? now;
    const from = query.from ?? new Date(to.getTime() - 30 * DAY_MS);
    const slaHours = await OpsSettingsService.get('ops.support.firstResponseSlaHours', this.prisma);
    const priorities: SupportTicketPriority[] = ['HIGH', 'NORMAL', 'LOW'];

    const [tickets, openUnanswered] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { id: true, priority: true, status: true, createdAt: true, firstResponseAt: true, resolvedAt: true },
        orderBy: { createdAt: 'desc' },
        take: SLA_SAMPLE_LIMIT,
      }),
      this.prisma.supportTicket.findMany({
        where: { status: { not: 'RESOLVED' }, firstResponseAt: null },
        select: {
          id: true,
          subject: true,
          priority: true,
          status: true,
          createdAt: true,
          store: { select: { id: true, name: true, code: true } },
          assignee: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: OVERDUE_SCAN_LIMIT,
      }),
    ]);

    const isBreached = (ticket: { priority: SupportTicketPriority; createdAt: Date; firstResponseAt: Date | null }) =>
      (ticket.firstResponseAt ?? now).getTime() - ticket.createdAt.getTime() > slaHours[ticket.priority] * HOUR_MS;

    const summarize = (list: typeof tickets) => {
      const firstResponse = list.filter((t) => t.firstResponseAt).map((t) => minutesBetween(t.createdAt, t.firstResponseAt!));
      const resolution = list.filter((t) => t.resolvedAt).map((t) => minutesBetween(t.createdAt, t.resolvedAt!));
      return {
        total: list.length,
        responded: firstResponse.length,
        resolved: resolution.length,
        firstResponseMinutes: { avg: average(firstResponse), p50: percentile(firstResponse, 50), p95: percentile(firstResponse, 95) },
        resolutionMinutes: { avg: average(resolution), p50: percentile(resolution, 50), p95: percentile(resolution, 95) },
        breachedFirstResponse: list.filter(isBreached).length,
      };
    };

    const overdueAll = openUnanswered
      .filter((t) => isBreached({ priority: t.priority, createdAt: t.createdAt, firstResponseAt: null }))
      .map((t) => ({
        ...t,
        waitingMinutes: minutesBetween(t.createdAt, now),
        slaHours: slaHours[t.priority],
      }))
      .sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority) || b.waitingMinutes - a.waitingMinutes);
    const overdue = { count: overdueAll.length, items: overdueAll.slice(0, OVERDUE_RESULT_LIMIT) };

    return {
      from,
      to,
      slaHours,
      overall: summarize(tickets),
      byPriority: priorities.map((priority) => ({ priority, ...summarize(tickets.filter((t) => t.priority === priority)) })),
      overdue,
      truncated: tickets.length === SLA_SAMPLE_LIMIT,
    };
  }

  // ---------------------------------------------------------------------------
  // B3 — Platform growth (platform-level counts only)
  // ---------------------------------------------------------------------------

  async getGrowth(query: GrowthQuery, now: Date = new Date()) {
    const todayKey = toBusinessDateKey(now);
    const bucketKeys: string[] = [];
    let rangeStartKey: string;

    if (query.period === 'month') {
      const [year, month] = todayKey.split('-').map(Number);
      for (let i = query.periods - 1; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(year, month - 1 - i, 1));
        bucketKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      }
      rangeStartKey = `${bucketKeys[0]}-01`;
    } else {
      const weekday = (new Date(`${todayKey}T00:00:00.000Z`).getUTCDay() + 6) % 7; // Monday = 0
      const currentWeekStart = addBusinessDays(todayKey, -weekday);
      for (let i = query.periods - 1; i >= 0; i -= 1) bucketKeys.push(addBusinessDays(currentWeekStart, -7 * i));
      rangeStartKey = bucketKeys[0];
    }
    const rangeStart = businessDateRangeToUtc(rangeStartKey).startUtc;

    const bucketOf = (date: Date) => {
      const key = toBusinessDateKey(date);
      if (query.period === 'month') return key.slice(0, 7);
      const weekday = (new Date(`${key}T00:00:00.000Z`).getUTCDay() + 6) % 7;
      return addBusinessDays(key, -weekday);
    };

    const dormantCutoff = new Date(now.getTime() - query.dormantDays * DAY_MS);
    const [stores, leads, matureStores] = await Promise.all([
      this.prisma.store.findMany({ where: { createdAt: { gte: rangeStart } }, select: { createdAt: true } }),
      this.prisma.contactLead.findMany({ where: { createdAt: { gte: rangeStart } }, select: { createdAt: true, status: true } }),
      this.prisma.store.findMany({
        where: { isActive: true, createdAt: { lt: dormantCutoff } },
        select: { id: true, name: true, code: true, createdAt: true },
        take: DORMANT_SCAN_LIMIT,
      }),
    ]);

    const buckets = new Map(bucketKeys.map((key) => [key, { bucket: key, newStores: 0, newLeads: 0, convertedLeads: 0 }]));
    for (const store of stores) {
      const bucket = buckets.get(bucketOf(store.createdAt));
      if (bucket) bucket.newStores += 1;
    }
    for (const lead of leads) {
      const bucket = buckets.get(bucketOf(lead.createdAt));
      if (!bucket) continue;
      bucket.newLeads += 1;
      if (lead.status === 'CONVERTED') bucket.convertedLeads += 1;
    }

    const lastOrders = matureStores.length
      ? await this.prisma.order.groupBy({
          by: ['storeId'],
          where: { storeId: { in: matureStores.map((s) => s.id) }, status: { in: ['CONFIRMED', 'FULFILLED'] } },
          _max: { createdAt: true },
        })
      : [];
    const lastOrderByStore = new Map(lastOrders.map((row) => [row.storeId, row._max.createdAt]));
    const dormant = matureStores
      .map((store) => ({ ...store, lastOrderAt: lastOrderByStore.get(store.id) ?? null }))
      .filter((store) => !store.lastOrderAt || store.lastOrderAt < dormantCutoff)
      .sort((a, b) => (a.lastOrderAt?.getTime() ?? 0) - (b.lastOrderAt?.getTime() ?? 0));

    const totalLeads = leads.length;
    const convertedLeads = leads.filter((l) => l.status === 'CONVERTED').length;
    return {
      period: query.period,
      buckets: bucketKeys.map((key) => buckets.get(key)!),
      totals: {
        newStores: stores.length,
        newLeads: totalLeads,
        convertedLeads,
        leadConversionRate: totalLeads === 0 ? null : Math.round((convertedLeads / totalLeads) * 1000) / 10,
      },
      dormant: {
        days: query.dormantDays,
        count: dormant.length,
        items: dormant.slice(0, DORMANT_RESULT_LIMIT),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // C4 — Settings history & restore, ops settings
  // ---------------------------------------------------------------------------

  async listSettingHistory(query: SettingHistoryQuery) {
    const where: Prisma.AuditLogWhereInput = {
      entityType: 'SYSTEM_SETTING',
      action: { in: SETTING_AUDIT_ACTIONS },
      ...(query.key ? { afterJson: { path: '$.key', equals: query.key } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { user: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const items = rows.map((row) => {
      const before = asObject(row.beforeJson);
      const after = asObject(row.afterJson);
      const key = String(after?.key ?? before?.key ?? '');
      return {
        id: row.id.toString(),
        action: row.action,
        key,
        before: before && 'value' in before ? before.value : null,
        after: after && 'value' in after ? after.value : null,
        reason: after?.reason ?? null,
        createdAt: row.createdAt,
        user: row.user,
        canRestore: Boolean(before && 'value' in before) && ((SYSTEM_SETTING_KEYS as string[]).includes(key) || OpsSettingsService.isOpsKey(key)),
      };
    });

    return { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  }

  /** Re-applies the value a setting had *before* the given change. The restore itself is audited. */
  async restoreSetting(auditId: string, reason: string, actorUserId: number, meta: RequestMeta = {}) {
    const log = await this.prisma.auditLog.findUnique({ where: { id: BigInt(auditId) } });
    if (!log || log.entityType !== 'SYSTEM_SETTING' || !SETTING_AUDIT_ACTIONS.includes(log.action)) {
      throw new NotFoundError('Không tìm thấy lịch sử thay đổi cài đặt');
    }
    const before = asObject(log.beforeJson);
    const key = String(asObject(log.afterJson)?.key ?? before?.key ?? '');
    if (!before || !('value' in before)) {
      throw new ValidationError('Bản ghi này không có giá trị trước đó để khôi phục');
    }

    let value: unknown;
    let current: unknown;
    if ((SYSTEM_SETTING_KEYS as string[]).includes(key)) {
      value = SystemSettingsService.parse(key as SystemSettingKey, before.value);
      current = await SystemSettingsService.get(key as SystemSettingKey, this.prisma);
    } else if (OpsSettingsService.isOpsKey(key)) {
      value = OpsSettingsService.parse(key, before.value);
      current = await OpsSettingsService.get(key, this.prisma);
    } else {
      throw new ValidationError('Cài đặt này không còn được hệ thống hỗ trợ');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, valueJson: value as Prisma.InputJsonValue, updatedById: actorUserId },
        update: { valueJson: value as Prisma.InputJsonValue, updatedById: actorUserId },
      });
      await AuditLogService.create(tx, {
        userId: actorUserId,
        action: 'SYSTEM_SETTING_RESTORED',
        entityType: 'SYSTEM_SETTING',
        beforeJson: { key, value: current },
        afterJson: { key, value, restoredFromAuditId: auditId, reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });

    return { key, value, restoredFromAuditId: auditId };
  }

  async getOpsSettings() {
    return OpsSettingsService.getAll(this.prisma);
  }

  async updateOpsSetting(key: OpsSettingKey, rawValue: unknown, actorUserId: number, meta: RequestMeta = {}) {
    const value = OpsSettingsService.parse(key, rawValue);
    const before = await OpsSettingsService.get(key, this.prisma);
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key },
        create: {
          key,
          valueJson: value as Prisma.InputJsonValue,
          description: 'Cài đặt vận hành nội bộ (chỉ admin)',
          updatedById: actorUserId,
        },
        update: { valueJson: value as Prisma.InputJsonValue, updatedById: actorUserId },
      });
      await AuditLogService.create(tx, {
        userId: actorUserId,
        action: 'SYSTEM_SETTING_UPDATED',
        entityType: 'SYSTEM_SETTING',
        beforeJson: { key, value: before },
        afterJson: { key, value },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });
    return { key, value };
  }

  // ---------------------------------------------------------------------------
  // C1 — Data retention report (DRY RUN: read-only, nothing is ever deleted here)
  // ---------------------------------------------------------------------------

  async getRetentionReport(query: RetentionQuery, now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - query.olderThanDays * DAY_MS);
    const old = { createdAt: { lt: cutoff } };

    const [auditTotal, auditOld, aiTotal, aiOld, notifTotal, notifOldRead, attachTotal, attachOld, tableSizes] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.count({ where: old }),
      this.prisma.aiInteraction.count(),
      this.prisma.aiInteraction.count({ where: old }),
      this.prisma.notification.count(),
      this.prisma.notification.count({ where: { ...old, isRead: true } }),
      this.prisma.supportTicketAttachment.aggregate({ _count: { _all: true }, _sum: { size: true } }),
      this.prisma.supportTicketAttachment.aggregate({ where: old, _count: { _all: true }, _sum: { size: true } }),
      this.getTableSizes(),
    ]);

    return {
      mode: 'DRY_RUN' as const,
      olderThanDays: query.olderThanDays,
      cutoff,
      candidates: [
        {
          table: 'audit_logs',
          total: auditTotal,
          olderThanCutoff: auditOld,
          recommendation: 'Giữ tối thiểu 1 năm để phục vụ kiểm toán; chỉ xóa khi nhóm đã chốt chính sách lưu giữ.',
        },
        {
          table: 'ai_interactions',
          total: aiTotal,
          olderThanCutoff: aiOld,
          recommendation: 'Chứa nội dung câu hỏi/trả lời của cửa hàng — nên đặt hạn lưu giữ ngắn (ví dụ 90–180 ngày).',
        },
        {
          table: 'notifications',
          total: notifTotal,
          olderThanCutoff: notifOldRead,
          recommendation: 'Chỉ tính thông báo đã đọc; có thể xóa an toàn nhất trong các bảng.',
        },
        {
          table: 'support_ticket_attachments',
          total: attachTotal._count._all,
          totalBytes: attachTotal._sum.size ?? 0,
          olderThanCutoff: attachOld._count._all,
          olderThanCutoffBytes: attachOld._sum.size ?? 0,
          recommendation: 'Ảnh lưu dạng LongBlob trong DB — nên chuyển sang lưu file ngoài DB thay vì xóa.',
        },
      ],
      largestTables: tableSizes,
      note: 'Chế độ chạy thử: chưa xóa bất kỳ dữ liệu nào. Xóa thật cần chủ dự án chốt chính sách lưu giữ.',
    };
  }

  /** MySQL table sizes from information_schema (read-only). Returns [] if not permitted. */
  private async getTableSizes() {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ tableName: string; tableRows: bigint | number | null; dataBytes: bigint | number | null; indexBytes: bigint | number | null }>>`
        SELECT TABLE_NAME AS tableName, TABLE_ROWS AS tableRows, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
        LIMIT 15`;
      return (rows ?? []).map((row) => ({
        table: row.tableName,
        approxRows: Number(row.tableRows ?? 0),
        dataBytes: Number(row.dataBytes ?? 0),
        indexBytes: Number(row.indexBytes ?? 0),
      }));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // B5 — Transfer store ownership
  // ---------------------------------------------------------------------------

  async transferStoreOwner(storeId: number, input: TransferOwnerInput, actorUserId: number, meta: RequestMeta = {}) {
    const actor = await this.prisma.user.findUnique({ where: { id: actorUserId }, select: { passwordHash: true } });
    if (!actor || !(await comparePassword(input.actorPassword, actor.passwordHash))) {
      throw new ForbiddenError('Mật khẩu xác nhận không đúng');
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent transfers for the same store so the single-owner invariant holds.
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${storeId} FOR UPDATE`;

      const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, code: true } });
      if (!store) throw new NotFoundError('Không tìm thấy cửa hàng');

      const newOwner = await tx.user.findUnique({
        where: { id: input.newOwnerUserId },
        select: { id: true, fullName: true, email: true, role: true, isActive: true, storeId: true },
      });
      if (!newOwner || newOwner.storeId !== storeId) {
        throw new ValidationError('Người nhận phải là nhân viên thuộc chính cửa hàng này');
      }
      if (!newOwner.isActive) throw new ValidationError('Tài khoản người nhận đang bị khóa, hãy mở khóa trước');
      if (newOwner.role === 'SHOP_OWNER') throw new ConflictError('Người này đã là chủ cửa hàng');
      if (newOwner.role !== 'WAREHOUSE_STAFF') throw new ValidationError('Chỉ có thể chuyển quyền cho nhân viên của cửa hàng');

      const formerOwners = await tx.user.findMany({
        where: { storeId, role: 'SHOP_OWNER' },
        select: { id: true, fullName: true, email: true, isActive: true },
      });

      await tx.user.updateMany({
        where: { storeId, role: 'SHOP_OWNER' },
        data: { role: 'WAREHOUSE_STAFF', ...(input.deactivateFormerOwner ? { isActive: false } : {}) },
      });
      await tx.user.update({ where: { id: newOwner.id }, data: { role: 'SHOP_OWNER' } });

      // Roles are re-read from the DB on every request, but refresh tokens must not outlive the change.
      const affectedUserIds = [newOwner.id, ...formerOwners.map((o) => o.id)];
      const revoked = await tx.authSession.updateMany({
        where: { userId: { in: affectedUserIds }, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const activeOwners = await tx.user.count({ where: { storeId, role: 'SHOP_OWNER', isActive: true } });
      if (activeOwners !== 1) {
        throw new ConflictError('Không bảo đảm được mỗi cửa hàng chỉ có 1 chủ, thao tác đã được hủy');
      }

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId,
        action: 'STORE_OWNER_TRANSFERRED',
        entityType: 'STORE',
        entityId: storeId,
        beforeJson: { ownerUserIds: formerOwners.map((o) => o.id), newOwnerRole: newOwner.role },
        afterJson: {
          ownerUserId: newOwner.id,
          formerOwnerUserIds: formerOwners.map((o) => o.id),
          formerOwnersDeactivated: input.deactivateFormerOwner,
          revokedSessions: revoked.count,
          reason: input.reason,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return {
        store,
        newOwner: { id: newOwner.id, fullName: newOwner.fullName, email: newOwner.email },
        formerOwners: formerOwners.map((o) => ({ id: o.id, fullName: o.fullName, email: o.email })),
        formerOwnersDeactivated: input.deactivateFormerOwner,
        revokedSessions: revoked.count,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // B2 — Announcements to shops
  // ---------------------------------------------------------------------------

  async broadcastAnnouncement(input: BroadcastInput, actorUserId: number, meta: RequestMeta = {}) {
    const roles = input.roles ?? ['SHOP_OWNER', 'WAREHOUSE_STAFF'];
    const recipients = await this.prisma.user.findMany({
      where: {
        isActive: true,
        role: { in: roles },
        storeId: input.storeIds ? { in: input.storeIds } : { not: null },
        store: { isActive: true },
      },
      select: { id: true, storeId: true },
      take: BROADCAST_MAX_RECIPIENTS + 1,
    });
    if (recipients.length === 0) throw new ValidationError('Không có người nhận phù hợp với điều kiện đã chọn');
    if (recipients.length > BROADCAST_MAX_RECIPIENTS) {
      throw new ValidationError(`Số người nhận vượt giới hạn ${BROADCAST_MAX_RECIPIENTS}, hãy gửi theo nhóm cửa hàng`);
    }

    const announcementId = crypto.randomUUID();
    let sent = 0;
    for (let i = 0; i < recipients.length; i += BROADCAST_CHUNK) {
      const chunk = recipients.slice(i, i + BROADCAST_CHUNK);
      const result = await this.prisma.notification.createMany({
        data: chunk.map((user) => ({
          storeId: user.storeId!,
          userId: user.id,
          type: 'announcement',
          title: input.title,
          message: input.message,
          entityType: 'ANNOUNCEMENT',
          entityId: announcementId,
        })),
      });
      sent += result.count;
    }

    const storeCount = new Set(recipients.map((r) => r.storeId)).size;
    await AuditLogService.create(this.prisma, {
      userId: actorUserId,
      action: 'ANNOUNCEMENT_SENT',
      entityType: 'ANNOUNCEMENT',
      entityId: announcementId,
      afterJson: { title: input.title, recipients: sent, storeCount, roles, storeIds: input.storeIds ?? 'ALL' },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { announcementId, recipients: sent, storeCount };
  }
}
