import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { HttpMetricsService } from '../../common/services/http-metrics.service';
import { SystemSettingKey, SystemSettingsService } from '../../common/services/system-settings.service';
import { comparePassword, hashPassword } from '../../common/utils/password';
import { AuthService } from '../auth/auth.service';
import { buildPaginationResult } from '../../common/utils/pagination';
import { businessDateRangeToUtc, toBusinessDateKey } from '../../common/utils/business-date';
import {
  AdminAiUsageQuery,
  AdminAuditLogFilter,
  AdminAuditLogQuery,
  AdminLeadListQuery,
  AdminStoreListQuery,
  AdminUserListQuery,
  CreateAdminUserInput,
  RevokeSessionsInput,
  UpdateLeadStatusInput,
  UpdateStatusInput,
} from './admin.schema';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const AUDIT_EXPORT_MAX_ROWS = 5000;
const DEFAULT_AI_USAGE_WINDOW_DAYS = 30;
/** A store with no login for this many days is reported as idle. */
const STORE_IDLE_DAYS = 14;

const auditLogInclude = {
  user: { select: { id: true, fullName: true, email: true, role: true } },
  store: { select: { id: true, name: true, code: true } },
} satisfies Prisma.AuditLogInclude;

const adminUserSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  storeId: true,
  createdAt: true,
  updatedAt: true,
  store: { select: { id: true, name: true, code: true, isActive: true } },
} satisfies Prisma.UserSelect;

type AuditLogWithRelations = Prisma.AuditLogGetPayload<{ include: typeof auditLogInclude }>;

function serializeAuditLog(log: AuditLogWithRelations) {
  return { ...log, id: log.id.toString() };
}

export class AdminService {
  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  async getDashboard() {
    const { startUtc, endUtc } = businessDateRangeToUtc(toBusinessDateKey(new Date()));

    const [totalStores, activeStores, usersByRole, lockedUsers, auditEventsToday, newLeads, recentLogs] =
      await Promise.all([
        prisma.store.count(),
        prisma.store.count({ where: { isActive: true } }),
        prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
        prisma.user.count({ where: { isActive: false } }),
        prisma.auditLog.count({ where: { createdAt: { gte: startUtc, lt: endUtc } } }),
        prisma.contactLead.count({ where: { status: 'NEW' } }),
        prisma.auditLog.findMany({ include: auditLogInclude, orderBy: { createdAt: 'desc' }, take: 10 }),
      ]);

    const byRole = { SHOP_OWNER: 0, WAREHOUSE_STAFF: 0, ADMIN: 0 };
    for (const row of usersByRole) {
      byRole[row.role] = row._count._all;
    }
    const totalUsers = byRole.SHOP_OWNER + byRole.WAREHOUSE_STAFF + byRole.ADMIN;

    return {
      stores: { total: totalStores, active: activeStores, inactive: totalStores - activeStores },
      users: { total: totalUsers, active: totalUsers - lockedUsers, locked: lockedUsers, byRole },
      security: {
        sensitiveFieldMasking: true,
        tenantIsolation: true,
        rateLimitEnabled: env.NODE_ENV === 'production',
      },
      auditEventsToday,
      newLeads,
      recentAuditLogs: recentLogs.map(serializeAuditLog),
    };
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async listUsers(query: AdminUserListQuery) {
    const { page, limit } = query;
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.search
        ? { OR: [{ fullName: { contains: query.search } }, { email: { contains: query.search } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: adminUserSelect,
        orderBy: { createdAt: query.order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    const lastLoginMap = await this.getLastLoginMap(items.map((u) => u.id));
    const enriched = items.map((u) => ({ ...u, lastLoginAt: lastLoginMap.get(u.id) ?? null }));

    return buildPaginationResult(enriched, total, page, limit);
  }

  async getUserDetail(userId: number) {
    const now = new Date();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...adminUserSelect,
        _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: now } } } } },
      },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy người dùng');
    }

    const [lastLoginMap, recentLogs] = await Promise.all([
      this.getLastLoginMap([user.id]),
      prisma.auditLog.findMany({
        where: { userId: user.id },
        include: auditLogInclude,
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const { _count, ...rest } = user;
    return {
      ...rest,
      lastLoginAt: lastLoginMap.get(user.id) ?? null,
      activeSessionCount: _count.sessions,
      recentAuditLogs: recentLogs.map(serializeAuditLog),
    };
  }

  async createAdminUser(input: CreateAdminUserInput, actorUserId: number, meta: RequestMeta = {}) {
    await this.verifyActorPassword(actorUserId, input.actorPassword);

    const email = input.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const passwordHash = await hashPassword(input.password);

    return prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, passwordHash, fullName: input.fullName.trim(), role: 'ADMIN', storeId: null },
        select: adminUserSelect,
      });

      await AuditLogService.create(tx, {
        storeId: null,
        userId: actorUserId,
        action: 'USER_CREATED',
        entityType: 'USER',
        entityId: created.id,
        afterJson: { userId: created.id, role: created.role, isActive: created.isActive, storeId: null },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return created;
    });
  }

  async updateUserStatus(userId: number, input: UpdateStatusInput, actorUserId: number, meta: RequestMeta = {}) {
    if (userId === actorUserId) {
      throw new ForbiddenError('Không thể tự khóa hoặc mở khóa tài khoản của chính mình');
    }

    const existing = await prisma.user.findUnique({ where: { id: userId }, select: adminUserSelect });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy người dùng');
    }

    if (existing.isActive === input.isActive) {
      return { ...existing, revokedSessions: 0 };
    }

    if (!input.isActive && existing.role === 'ADMIN') {
      await this.verifyActorPassword(actorUserId, input.actorPassword);
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isActive: input.isActive },
        select: adminUserSelect,
      });

      let revokedSessions = 0;
      if (!input.isActive) {
        const revoked = await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        revokedSessions = revoked.count;
      }

      await AuditLogService.create(tx, {
        storeId: existing.storeId,
        userId: actorUserId,
        action: input.isActive ? 'USER_UNLOCKED' : 'USER_LOCKED',
        entityType: 'USER',
        entityId: userId,
        beforeJson: { userId, role: existing.role, isActive: existing.isActive },
        afterJson: { userId, role: updated.role, isActive: updated.isActive, reason: input.reason ?? null, revokedSessions },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { ...updated, revokedSessions };
    });
  }

  /** Signs the user out of every device without locking the account. */
  async revokeUserSessions(userId: number, input: RevokeSessionsInput, actorUserId: number, meta: RequestMeta = {}) {
    if (userId === actorUserId) {
      throw new ForbiddenError('Dùng chức năng Đăng xuất để thoát phiên của chính bạn');
    }

    const existing = await prisma.user.findUnique({ where: { id: userId }, select: adminUserSelect });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy người dùng');
    }

    return prisma.$transaction(async (tx) => {
      const revoked = await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await AuditLogService.create(tx, {
        storeId: existing.storeId,
        userId: actorUserId,
        action: 'USER_SESSIONS_REVOKED',
        entityType: 'USER',
        entityId: userId,
        afterJson: { userId, revokedSessions: revoked.count, reason: input.reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { userId, revokedSessions: revoked.count };
    });
  }

  /**
   * Emails the user a one-time reset code through the normal "forgot password" flow.
   * The admin never sees or sets the password.
   */
  async sendPasswordReset(userId: number, actorUserId: number, meta: RequestMeta = {}, authService = new AuthService()) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: adminUserSelect,
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy người dùng');
    }
    if (!existing.isActive || (existing.storeId && !existing.store?.isActive)) {
      throw new ConflictError('Tài khoản hoặc cửa hàng đang bị khóa. Mở khóa trước khi gửi mã đặt lại mật khẩu.');
    }

    const result = await authService.forgotPassword({ email: existing.email });

    await AuditLogService.create(prisma, {
      storeId: existing.storeId,
      userId: actorUserId,
      action: 'PASSWORD_RESET_SENT_BY_ADMIN',
      entityType: 'USER',
      entityId: userId,
      afterJson: { userId, emailSent: Boolean((result as any).sent), simulated: Boolean((result as any).simulated) },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    // Never return the OTP/reset token to the admin, even in development.
    return {
      email: existing.email,
      emailSent: Boolean((result as any).sent),
      simulated: Boolean((result as any).simulated),
      expiresAt: result.expiresAt,
    };
  }

  private async verifyActorPassword(actorUserId: number, password: string | undefined) {
    if (!password) {
      throw new ValidationError('Vui lòng nhập mật khẩu của bạn để xác nhận thao tác này');
    }
    const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { passwordHash: true } });
    if (!actor || !(await comparePassword(password, actor.passwordHash))) {
      throw new ForbiddenError('Mật khẩu xác nhận không đúng');
    }
  }

  private async getLastLoginMap(userIds: number[]) {
    const map = new Map<number, Date>();
    if (userIds.length === 0) return map;

    const rows = await prisma.authSession.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _max: { createdAt: true },
    });
    for (const row of rows) {
      if (row._max.createdAt) map.set(row.userId, row._max.createdAt);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Stores (overview only — admin never reads a store's business records)
  // ---------------------------------------------------------------------------

  async listStores(query: AdminStoreListQuery) {
    const { page, limit } = query;
    const where: Prisma.StoreWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { code: { contains: query.search } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    };

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where,
        select: {
          id: true,
          name: true,
          code: true,
          phone: true,
          address: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          users: {
            where: { role: 'SHOP_OWNER' },
            select: { id: true, fullName: true, email: true, isActive: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          _count: { select: { users: true, products: true, stockItems: true, orders: true } },
        },
        orderBy: { createdAt: query.order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.store.count({ where }),
    ]);

    const activity = await this.getStoreActivity(stores.map((store) => store.id));

    const items = stores.map(({ users, _count, ...store }) => {
      const storeActivity = activity.get(store.id);
      return {
        ...store,
        owner: users[0] ?? null,
        stats: {
          users: _count.users,
          products: _count.products,
          skus: _count.stockItems,
          orders: _count.orders,
          ordersLast30Days: storeActivity?.ordersLast30Days ?? 0,
          lastOrderAt: storeActivity?.lastOrderAt ?? null,
        },
        lastActiveAt: storeActivity?.lastActiveAt ?? null,
        payos: storeActivity?.payos ?? 'NOT_CONFIGURED',
      };
    });

    return buildPaginationResult(items, total, page, limit);
  }

  /** Platform-wide store counters for the stores page header. */
  async getStoreSummary() {
    const idleSince = new Date(Date.now() - STORE_IDLE_DAYS * 24 * 60 * 60 * 1000);
    const [total, active, payosActive, activeRecently] = await Promise.all([
      prisma.store.count(),
      prisma.store.count({ where: { isActive: true } }),
      prisma.storePaymentConfig.count({ where: { provider: 'PAYOS', isActive: true } }),
      prisma.store.count({
        where: { isActive: true, users: { some: { sessions: { some: { createdAt: { gte: idleSince } } } } } },
      }),
    ]);
    return { total, active, locked: total - active, payosActive, idle: active - activeRecently, idleDays: STORE_IDLE_DAYS };
  }

  /**
   * Batched per-store activity for a page of stores (no per-row queries): PayOS status,
   * orders in the last 30 days, last order and last login of any account in the store.
   */
  private async getStoreActivity(storeIds: number[]) {
    const result = new Map<
      number,
      { payos: 'ACTIVE' | 'DISABLED' | 'NOT_CONFIGURED'; ordersLast30Days: number; lastOrderAt: Date | null; lastActiveAt: Date | null }
    >();
    if (storeIds.length === 0) return result;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [payosConfigs, recentOrders, lastOrders, storeUsers] = await Promise.all([
      prisma.storePaymentConfig.findMany({
        where: { storeId: { in: storeIds }, provider: 'PAYOS' },
        select: { storeId: true, isActive: true },
      }),
      prisma.order.groupBy({
        by: ['storeId'],
        where: { storeId: { in: storeIds }, createdAt: { gte: thirtyDaysAgo } },
        _count: { _all: true },
      }),
      prisma.order.groupBy({ by: ['storeId'], where: { storeId: { in: storeIds } }, _max: { createdAt: true } }),
      prisma.user.findMany({ where: { storeId: { in: storeIds } }, select: { id: true, storeId: true } }),
    ]);
    const lastLogin = await this.getLastLoginMap(storeUsers.map((u) => u.id));

    for (const storeId of storeIds) {
      result.set(storeId, { payos: 'NOT_CONFIGURED', ordersLast30Days: 0, lastOrderAt: null, lastActiveAt: null });
    }
    for (const config of payosConfigs) {
      result.get(config.storeId)!.payos = config.isActive ? 'ACTIVE' : 'DISABLED';
    }
    for (const row of recentOrders) {
      result.get(row.storeId)!.ordersLast30Days = row._count._all;
    }
    for (const row of lastOrders) {
      result.get(row.storeId)!.lastOrderAt = row._max.createdAt;
    }
    for (const user of storeUsers) {
      const loginAt = lastLogin.get(user.id);
      const entry = user.storeId ? result.get(user.storeId) : undefined;
      if (entry && loginAt && (!entry.lastActiveAt || loginAt > entry.lastActiveAt)) {
        entry.lastActiveAt = loginAt;
      }
    }
    return result;
  }

  async getStoreDetail(storeId: number) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        code: true,
        phone: true,
        address: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { products: true, stockItems: true, orders: true, warehouses: true } },
      },
    });

    if (!store) {
      throw new NotFoundError('Không tìm thấy cửa hàng');
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [owners, usersByRole, paymentConfigs, lastOrder, ordersLast30Days] = await Promise.all([
      prisma.user.findMany({
        where: { storeId, role: 'SHOP_OWNER' },
        select: { id: true, fullName: true, email: true, isActive: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.user.groupBy({ by: ['role'], where: { storeId }, _count: { _all: true } }),
      prisma.storePaymentConfig.findMany({
        where: { storeId },
        select: { provider: true, isActive: true, configuredAt: true },
      }),
      prisma.order.findFirst({ where: { storeId }, select: { createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.order.count({ where: { storeId, createdAt: { gte: thirtyDaysAgo } } }),
    ]);

    const staffByRole = { SHOP_OWNER: 0, WAREHOUSE_STAFF: 0 };
    for (const row of usersByRole) {
      if (row.role === 'SHOP_OWNER' || row.role === 'WAREHOUSE_STAFF') {
        staffByRole[row.role] = row._count._all;
      }
    }

    const { _count, ...rest } = store;
    return {
      ...rest,
      owners,
      stats: {
        owners: staffByRole.SHOP_OWNER,
        staff: staffByRole.WAREHOUSE_STAFF,
        products: _count.products,
        skus: _count.stockItems,
        warehouses: _count.warehouses,
        orders: _count.orders,
        ordersLast30Days,
        lastOrderAt: lastOrder?.createdAt ?? null,
      },
      paymentConfigs,
    };
  }

  async updateStoreStatus(storeId: number, input: UpdateStatusInput, actorUserId: number, meta: RequestMeta = {}) {
    const existing = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, code: true, isActive: true },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy cửa hàng');
    }

    if (existing.isActive === input.isActive) {
      return { ...existing, revokedSessions: 0 };
    }

    if (!input.isActive) {
      await this.verifyActorPassword(actorUserId, input.actorPassword);
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.store.update({
        where: { id: storeId },
        data: { isActive: input.isActive },
        select: { id: true, name: true, code: true, isActive: true, updatedAt: true },
      });

      let revokedSessions = 0;
      if (!input.isActive) {
        const revoked = await tx.authSession.updateMany({
          where: { revokedAt: null, user: { storeId } },
          data: { revokedAt: new Date() },
        });
        revokedSessions = revoked.count;
      }

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId,
        action: input.isActive ? 'STORE_UNLOCKED' : 'STORE_LOCKED',
        entityType: 'STORE',
        entityId: storeId,
        beforeJson: { storeId, code: existing.code, isActive: existing.isActive },
        afterJson: { storeId, code: updated.code, isActive: updated.isActive, reason: input.reason ?? null, revokedSessions },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { ...updated, revokedSessions };
    });
  }

  // ---------------------------------------------------------------------------
  // Audit logs
  // ---------------------------------------------------------------------------

  async listAuditLogs(query: AdminAuditLogQuery) {
    const { page, limit } = query;
    const where = buildAuditLogWhere(query);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: auditLogInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return buildPaginationResult(logs.map(serializeAuditLog), total, page, limit);
  }

  async exportAuditLogsCsv(filter: AdminAuditLogFilter, actorUserId: number, meta: RequestMeta = {}) {
    const where = buildAuditLogWhere(filter);
    const logs = await prisma.auditLog.findMany({
      where,
      include: auditLogInclude,
      orderBy: { createdAt: 'desc' },
      take: AUDIT_EXPORT_MAX_ROWS,
    });

    await AuditLogService.create(prisma, {
      storeId: null,
      userId: actorUserId,
      action: 'AUDIT_LOG_EXPORTED',
      entityType: 'AUDIT_LOG',
      afterJson: { filter, rowCount: logs.length },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const header = [
      'id',
      'createdAt',
      'storeCode',
      'storeName',
      'userEmail',
      'userName',
      'userRole',
      'action',
      'entityType',
      'entityId',
      'ipAddress',
      'beforeJson',
      'afterJson',
    ];
    const rows = logs.map((log) => [
      log.id.toString(),
      log.createdAt.toISOString(),
      log.store?.code ?? '',
      log.store?.name ?? '',
      log.user?.email ?? '',
      log.user?.fullName ?? '',
      log.user?.role ?? '',
      log.action,
      log.entityType,
      log.entityId ?? '',
      log.ipAddress ?? '',
      log.beforeJson === null ? '' : JSON.stringify(log.beforeJson),
      log.afterJson === null ? '' : JSON.stringify(log.afterJson),
    ]);

    // BOM so Excel opens the UTF-8 file with Vietnamese characters intact.
    return '﻿' + [header, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\r\n');
  }

  // ---------------------------------------------------------------------------
  // AI assistant usage
  // ---------------------------------------------------------------------------

  async getAiUsage(query: AdminAiUsageQuery) {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - DEFAULT_AI_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const where: Prisma.AiInteractionWhereInput = { createdAt: { gte: from, lte: to } };

    const [totals, byStatus, byStore, byStoreStatus] = await Promise.all([
      prisma.aiInteraction.aggregate({
        where,
        _count: { _all: true },
        _avg: { latencyMs: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      prisma.aiInteraction.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.aiInteraction.groupBy({
        by: ['storeId'],
        where,
        _count: { _all: true },
        _avg: { latencyMs: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      prisma.aiInteraction.groupBy({ by: ['storeId', 'status'], where, _count: { _all: true } }),
    ]);

    const stores = await prisma.store.findMany({
      where: { id: { in: byStore.map((row) => row.storeId) } },
      select: { id: true, name: true, code: true },
    });
    const storeMap = new Map(stores.map((s) => [s.id, s]));

    const statusCounts = { SUCCESS: 0, FAILED: 0, TIMEOUT: 0 };
    for (const row of byStatus) {
      statusCounts[row.status] = row._count._all;
    }

    const failuresByStore = new Map<number, number>();
    for (const row of byStoreStatus) {
      if (row.status !== 'SUCCESS') {
        failuresByStore.set(row.storeId, (failuresByStore.get(row.storeId) ?? 0) + row._count._all);
      }
    }

    const totalCount = totals._count._all;
    return {
      range: { from, to },
      totals: {
        interactions: totalCount,
        ...statusCounts,
        errorRate: totalCount === 0 ? 0 : (statusCounts.FAILED + statusCounts.TIMEOUT) / totalCount,
        avgLatencyMs: totals._avg.latencyMs === null ? null : Math.round(totals._avg.latencyMs),
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
      },
      byStore: byStore
        .map((row) => ({
          store: storeMap.get(row.storeId) ?? { id: row.storeId, name: null, code: null },
          interactions: row._count._all,
          failed: failuresByStore.get(row.storeId) ?? 0,
          avgLatencyMs: row._avg.latencyMs === null ? null : Math.round(row._avg.latencyMs),
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
        }))
        .sort((a, b) => b.interactions - a.interactions),
    };
  }

  // ---------------------------------------------------------------------------
  // System configuration status (read-only, never returns secret values)
  // ---------------------------------------------------------------------------

  async getConfigStatus() {
    const [storesWithPayos, activeSessions] = await Promise.all([
      prisma.storePaymentConfig.count({ where: { provider: 'PAYOS', isActive: true } }),
      prisma.authSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);

    const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD;
    const smsProvider = process.env.SMS_PROVIDER || 'simulation';

    return {
      environment: env.NODE_ENV,
      timezone: env.APP_TIMEZONE,
      tenantRootDomain: env.TENANT_ROOT_DOMAIN,
      auth: {
        accessTokenTtl: env.JWT_EXPIRES_IN,
        refreshTokenTtl: env.JWT_REFRESH_EXPIRES_IN,
        usingDefaultJwtSecrets: !process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET,
        activeSessions,
      },
      rateLimit: {
        enabled: env.NODE_ENV === 'production',
        general: { windowMs: env.GENERAL_RATE_LIMIT_WINDOW_MS, max: env.GENERAL_RATE_LIMIT_MAX },
        auth: { windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, max: env.AUTH_RATE_LIMIT_MAX },
      },
      integrations: {
        smtp: {
          configured: Boolean(smtpUser && smtpPass),
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: Number(process.env.SMTP_PORT) || 465,
        },
        cloudinary: {
          configured: Boolean(
            process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
          ),
        },
        sms: {
          provider: smsProvider,
          configured: smsProvider !== 'simulation' && Boolean(process.env.SMS_API_KEY),
        },
        payos: {
          encryptionKeyConfigured: Boolean(process.env.PAYMENT_CONFIG_ENCRYPTION_KEY),
          storesConfigured: storesWithPayos,
        },
      },
    };
  }

  async getSystemSettings() {
    return SystemSettingsService.getAll(prisma);
  }

  async updateSystemSetting(key: SystemSettingKey, rawValue: unknown, actorUserId: number, meta: RequestMeta = {}) {
    const value = SystemSettingsService.parse(key, rawValue);
    const before = await SystemSettingsService.get(key, prisma);

    await prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, valueJson: value as Prisma.InputJsonValue, updatedById: actorUserId },
        update: { valueJson: value as Prisma.InputJsonValue, updatedById: actorUserId },
      });

      await AuditLogService.create(tx, {
        storeId: null,
        userId: actorUserId,
        action: 'SYSTEM_SETTING_UPDATED',
        entityType: 'SYSTEM_SETTING',
        entityId: null,
        beforeJson: { key, value: before },
        afterJson: { key, value },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });

    const settings = await SystemSettingsService.getAll(prisma);
    return settings.find((setting) => setting.key === key)!;
  }

  async getSystemHealth() {
    let database: { status: 'UP' | 'DOWN'; latencyMs: number | null } = { status: 'DOWN', latencyMs: null };
    const started = process.hrtime.bigint();
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = { status: 'UP', latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000) };
    } catch {
      // reported as DOWN
    }

    const memory = process.memoryUsage();
    return {
      checkedAt: new Date().toISOString(),
      database,
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryRssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      http: HttpMetricsService.snapshot(),
    };
  }

  // ---------------------------------------------------------------------------
  // Contact leads (landing page)
  // ---------------------------------------------------------------------------

  async listLeads(query: AdminLeadListQuery) {
    const { page, limit } = query;
    const where: Prisma.ContactLeadWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search } },
              { phone: { contains: query.search } },
              { email: { contains: query.search } },
              { storeName: { contains: query.search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.contactLead.findMany({
        where,
        orderBy: { createdAt: query.order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.contactLead.count({ where }),
    ]);

    return buildPaginationResult(items, total, page, limit);
  }

  async updateLeadStatus(leadId: number, input: UpdateLeadStatusInput, actorUserId: number, meta: RequestMeta = {}) {
    const existing = await prisma.contactLead.findUnique({ where: { id: leadId } });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy khách hàng tiềm năng');
    }

    if (existing.status === input.status) {
      return existing;
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.contactLead.update({ where: { id: leadId }, data: { status: input.status } });

      await AuditLogService.create(tx, {
        storeId: null,
        userId: actorUserId,
        action: 'LEAD_STATUS_UPDATED',
        entityType: 'CONTACT_LEAD',
        entityId: leadId,
        beforeJson: { status: existing.status },
        afterJson: { status: updated.status },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return updated;
    });
  }
}

function buildAuditLogWhere(filter: AdminAuditLogFilter): Prisma.AuditLogWhereInput {
  return {
    ...(filter.storeId ? { storeId: filter.storeId } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.action ? { action: { contains: filter.action } } : {}),
    ...(filter.entityType ? { entityType: filter.entityType } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { action: { contains: filter.search } },
            { entityType: { contains: filter.search } },
            { entityId: { contains: filter.search } },
            { ipAddress: { contains: filter.search } },
            { user: { is: { email: { contains: filter.search } } } },
            { user: { is: { fullName: { contains: filter.search } } } },
          ],
        }
      : {}),
  };
}

function toCsvCell(value: string): string {
  // Neutralise spreadsheet formula injection, then quote every cell.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
