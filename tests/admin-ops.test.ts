import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import {
  LoginGuardService,
  loginAccountKey,
  maskEmail,
} from '../src/common/services/login-guard.service';
import { recordJobFailure } from '../src/common/services/job-state.service';
import { AdminOpsService, percentile } from '../src/modules/admin-ops/admin-ops.service';

const ADMIN_PASSWORD = 'Adm1nPassword!';
const OWNER_PASSWORD = 'Owner1Password!';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    store: { findUnique: jest.fn(), findMany: jest.fn() },
    auditLog: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
    authSession: { create: jest.fn(), updateMany: jest.fn() },
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    supportTicket: { findMany: jest.fn() },
    storePaymentConfig: { findMany: jest.fn() },
    payment: { groupBy: jest.fn() },
    contactLead: { findMany: jest.fn() },
    order: { groupBy: jest.fn() },
    notification: { createMany: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback: any) => callback(prisma)),
  },
}));

const db = prisma as any;

const users: Record<number, any> = {
  1: { id: 1, email: 'owner@store-a.test', fullName: 'Owner A', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true }, passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4) },
  2: { id: 2, email: 'staff@store-a.test', fullName: 'Staff A', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4) },
  4: { id: 4, email: 'staff@store-b.test', fullName: 'Staff B', role: 'WAREHOUSE_STAFF', storeId: 2, isActive: true, store: { isActive: true } },
};

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id !== undefined) return Promise.resolve(users[where.id] ?? null);
    return Promise.resolve(Object.values(users).find((u) => u.email === where.email) ?? null);
  });
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.findMany.mockResolvedValue([]);
  db.systemSetting.findUnique.mockResolvedValue(null);
  db.systemSetting.findMany.mockResolvedValue([]);
  db.authSession.create.mockResolvedValue({ id: 1 });
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
});

describe('helpers', () => {
  it('masks e-mails and derives a case-insensitive account key without the raw address', () => {
    expect(maskEmail('NguyenVanA@Shop.vn')).toBe('ng******@shop.vn');
    expect(maskEmail('a@b.vn')).toBe('a*@b.vn');
    expect(loginAccountKey(' Owner@Store-A.test ')).toBe(loginAccountKey('owner@store-a.test'));
    expect(loginAccountKey('owner@store-a.test')).toMatch(/^email:[a-f0-9]{40}$/);
    expect(loginAccountKey('owner@store-a.test')).not.toContain('owner');
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([5, 1, 9, 3, 7], 95)).toBe(9);
  });

  it('recordJobFailure never touches the default database in tests, and writes to an explicit client', async () => {
    await recordJobFailure('decision-nightly', new Error('boom'));
    expect(db.systemSetting.upsert).not.toHaveBeenCalled();

    const client = { systemSetting: { upsert: jest.fn().mockResolvedValue({}) } };
    await recordJobFailure('decision-nightly', new Error('boom'), client as any);
    expect(client.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'job:decision-nightly:last-failure' } })
    );
  });
});

describe('LoginGuardService (A1)', () => {
  const now = new Date('2026-10-27T03:00:00.000Z');
  const guard = new LoginGuardService(prisma as any);
  const key = loginAccountKey('owner@store-a.test');

  it('is not locked below the threshold', async () => {
    db.auditLog.findMany.mockResolvedValue([{ createdAt: minutesAgo(now, 1) }, { createdAt: minutesAgo(now, 2) }]);
    const state = await guard.getLockState(key, 1, now);
    expect(state).toMatchObject({ locked: false, failures: 2, maxAttempts: 5, windowMinutes: 15 });
  });

  it('locks after 5 failures in 15 minutes until the oldest one leaves the window', async () => {
    db.auditLog.findMany.mockResolvedValue([1, 2, 3, 4, 10].map((m) => ({ createdAt: minutesAgo(now, m) })));
    const state = await guard.getLockState(key, 1, now);
    expect(state.locked).toBe(true);
    expect(state.retryAfterMinutes).toBe(5);
  });

  it('counts only failures after the last successful login', async () => {
    const lastSuccess = minutesAgo(now, 3);
    db.auditLog.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.action === 'USER_LOGIN' ? { createdAt: lastSuccess } : null)
    );
    db.auditLog.findMany.mockResolvedValue([]);
    await guard.getLockState(key, 1, now);
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: { gt: lastSuccess }, entityId: key }) })
    );
  });

  it('can be disabled with maxAttempts = 0', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ valueJson: { maxAttempts: 0, windowMinutes: 15 } });
    const state = await guard.getLockState(key, 1, now);
    expect(state.locked).toBe(false);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('fails open when the audit table cannot be read', async () => {
    db.auditLog.findMany.mockRejectedValue(new Error('db down'));
    await expect(guard.assertNotLocked('owner@store-a.test', { userId: 1 })).resolves.toBeUndefined();
  });
});

describe('Login API integration (A1)', () => {
  const app = createApp();

  it('records LOGIN_FAILED with a masked e-mail on a wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@store-a.test', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'LOGIN_FAILED',
          entityType: 'AUTH_LOGIN',
          entityId: loginAccountKey('owner@store-a.test'),
          afterJson: { emailMasked: 'ow***@store-a.test', reason: 'WRONG_PASSWORD' },
        }),
      })
    );
  });

  it('records UNKNOWN_ACCOUNT but returns the same generic 401', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@nowhere.test', password: 'whatever123' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Tài khoản hoặc mật khẩu không chính xác');
    const call = db.auditLog.create.mock.calls.find((c: any[]) => c[0].data.action === 'LOGIN_FAILED');
    expect(call[0].data.afterJson.reason).toBe('UNKNOWN_ACCOUNT');
  });

  it('returns 429 while locked — even with the correct password — and logs LOGIN_BLOCKED', async () => {
    db.auditLog.findMany.mockResolvedValue([1, 2, 3, 4, 5].map((m) => ({ createdAt: minutesAgo(new Date(), m) })));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@store-a.test', password: OWNER_PASSWORD });
    expect(res.status).toBe(429);
    expect(db.authSession.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_BLOCKED' }) })
    );
  });

  it('still logs in normally with the correct password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@store-a.test', password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    expect(db.authSession.create).toHaveBeenCalled();
  });
});

describe('Admin ops API — access control', () => {
  const app = createApp();
  const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });
  const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/admin/ops/jobs');
    expect(res.status).toBe(401);
  });

  it('rejects shop owners', async () => {
    const res = await request(app).get('/api/v1/admin/ops/growth').set({ Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(403);
  });

  it('validates input (invalid account key)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/ops/security/accounts/not-a-key/clear-lock')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ reason: 'Khách gọi xác minh' });
    expect(res.status).toBe(400);
  });

  it('lets admins read job status', async () => {
    const res = await request(app).get('/api/v1/admin/ops/jobs').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ name: 'decision-nightly', status: 'NEVER_RUN' });
  });

  it('does not change the existing admin router (settings API still works)', async () => {
    const res = await request(app).get('/api/v1/admin/system/settings').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
  });
});

describe('AdminOpsService', () => {
  const now = new Date('2026-10-27T03:00:00.000Z');
  const decisionJobs = { recalculateStore: jest.fn() };
  const service = () => new AdminOpsService(prisma as any, new LoginGuardService(prisma as any), decisionJobs as any);

  describe('jobs (A2)', () => {
    it('reports FAILED when the last failure is newer than the last successful run', async () => {
      db.systemSetting.findMany.mockImplementation(({ where }: any) => {
        if (where.key?.startsWith) return Promise.resolve([]);
        return Promise.resolve([
          { key: 'job:decision-nightly:last-run', valueJson: { businessDate: '2026-10-26', processedSkus: 120 }, updatedAt: minutesAgo(now, 600) },
          { key: 'job:decision-nightly:last-failure', valueJson: { at: minutesAgo(now, 60).toISOString(), message: 'boom' }, updatedAt: now },
        ]);
      });
      const [job] = await service().getJobs(now);
      expect(job.status).toBe('FAILED');
      expect(job.lastFailure?.message).toBe('boom');
      expect(job.lastRun).toMatchObject({ businessDate: '2026-10-26', processedSkus: 120 });
    });

    it('reports RUNNING while the nightly lease is held and lists stores being recalculated', async () => {
      db.systemSetting.findMany.mockImplementation(({ where }: any) => {
        if (where.key?.startsWith) {
          return Promise.resolve([{ key: 'lease:decision-recalc:5', valueJson: { expiresAt: now.getTime() + 60000 } }]);
        }
        return Promise.resolve([{ key: 'lease:decision-nightly', valueJson: { expiresAt: now.getTime() + 60000 }, updatedAt: now }]);
      });
      const [job] = await service().getJobs(now);
      expect(job.status).toBe('RUNNING');
      expect(job.runningStoreRecalculations).toEqual([5]);
    });

    it('recalculates one active store and audits it', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', isActive: true });
      decisionJobs.recalculateStore.mockResolvedValue({ processed: 10, successCount: 9, failureCount: 1, remaining: 0 });
      const result = await service().runDecisionForStore(1, 3);
      expect(result).toMatchObject({ storeId: 1, processed: 10, failureCount: 1 });
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'DECISION_RECALC_TRIGGERED_BY_ADMIN', storeId: 1 }) })
      );
    });

    it('refuses to recalculate a suspended store', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', isActive: false });
      await expect(service().runDecisionForStore(1, 3)).rejects.toMatchObject({ statusCode: 409 });
      expect(decisionJobs.recalculateStore).not.toHaveBeenCalled();
    });
  });

  describe('payment health (A3)', () => {
    it('returns counts and timestamps only — never amounts', async () => {
      db.store.findMany.mockResolvedValue([{ id: 1, name: 'Store A', code: 'A', isActive: true }, { id: 2, name: 'Store B', code: 'B', isActive: true }]);
      db.storePaymentConfig.findMany.mockResolvedValue([{ storeId: 1, isActive: true, configuredAt: now }]);
      db.payment.groupBy
        .mockResolvedValueOnce([{ storeId: 1, _count: { _all: 2 }, _min: { createdAt: minutesAgo(now, 90) } }])
        .mockResolvedValueOnce([{ storeId: 1, _max: { paidAt: minutesAgo(now, 10) } }]);
      const result = await service().getPaymentHealth({}, now);
      expect(result.pendingMinutes).toBe(30);
      expect(result.summary).toEqual({ storesConfigured: 1, storesWithStuckPayments: 1, totalStuckPayments: 2 });
      expect(result.items).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/amount/i);
    });
  });

  describe('support SLA (B4)', () => {
    it('computes response times and lists unanswered tickets past their SLA', async () => {
      db.supportTicket.findMany
        .mockResolvedValueOnce([
          { id: 1, priority: 'HIGH', status: 'RESOLVED', createdAt: minutesAgo(now, 600), firstResponseAt: minutesAgo(now, 540), resolvedAt: minutesAgo(now, 300) },
          { id: 2, priority: 'HIGH', status: 'OPEN', createdAt: minutesAgo(now, 400), firstResponseAt: null, resolvedAt: null },
          { id: 3, priority: 'LOW', status: 'IN_PROGRESS', createdAt: minutesAgo(now, 100), firstResponseAt: minutesAgo(now, 80), resolvedAt: null },
        ])
        .mockResolvedValueOnce([
          { id: 2, subject: 'Không in được hóa đơn', priority: 'HIGH', status: 'OPEN', createdAt: minutesAgo(now, 400), store: { id: 1, name: 'A', code: 'A' }, assignee: null },
          { id: 9, subject: 'Hỏi cách nhập Excel', priority: 'LOW', status: 'OPEN', createdAt: minutesAgo(now, 120), store: { id: 1, name: 'A', code: 'A' }, assignee: null },
        ]);
      const result = await service().getSupportSla({}, now);
      expect(result.overall.firstResponseMinutes.avg).toBe(40);
      expect(result.overall.breachedFirstResponse).toBe(1);
      expect(result.overdue.count).toBe(1);
      expect(result.overdue.items[0]).toMatchObject({ id: 2, waitingMinutes: 400, slaHours: 4 });
    });
  });

  describe('growth (B3)', () => {
    it('buckets new stores/leads by month and finds dormant stores', async () => {
      db.store.findMany
        .mockResolvedValueOnce([{ createdAt: new Date('2026-10-05T03:00:00Z') }, { createdAt: new Date('2026-09-12T03:00:00Z') }])
        .mockResolvedValueOnce([
          { id: 1, name: 'Store A', code: 'A', createdAt: new Date('2026-01-01T00:00:00Z') },
          { id: 2, name: 'Store B', code: 'B', createdAt: new Date('2026-01-01T00:00:00Z') },
        ]);
      db.contactLead.findMany.mockResolvedValue([
        { createdAt: new Date('2026-10-02T03:00:00Z'), status: 'CONVERTED' },
        { createdAt: new Date('2026-10-03T03:00:00Z'), status: 'NEW' },
      ]);
      db.order.groupBy.mockResolvedValue([{ storeId: 1, _max: { createdAt: minutesAgo(now, 60) } }]);
      const result = await service().getGrowth({ period: 'month', periods: 3, dormantDays: 30 }, now);
      expect(result.buckets.map((b) => b.bucket)).toEqual(['2026-08', '2026-09', '2026-10']);
      expect(result.buckets[2]).toEqual({ bucket: '2026-10', newStores: 1, newLeads: 2, convertedLeads: 1 });
      expect(result.totals.leadConversionRate).toBe(50);
      expect(result.dormant.items.map((s) => s.id)).toEqual([2]);
    });
  });

  describe('settings history & restore (C4)', () => {
    it('restores the value a setting had before a change and audits the restore', async () => {
      db.auditLog.findUnique.mockResolvedValue({
        id: 42n,
        action: 'SYSTEM_SETTING_UPDATED',
        entityType: 'SYSTEM_SETTING',
        beforeJson: { key: 'signup.enabled', value: true },
        afterJson: { key: 'signup.enabled', value: false },
      });
      db.systemSetting.findUnique.mockResolvedValue({ valueJson: false });
      const result = await service().restoreSetting('42', 'Mở lại đăng ký sau bảo trì', 3);
      expect(result).toEqual({ key: 'signup.enabled', value: true, restoredFromAuditId: '42' });
      expect(db.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'signup.enabled' } }));
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'SYSTEM_SETTING_RESTORED' }) })
      );
    });

    it('rejects history rows without a previous value', async () => {
      db.auditLog.findUnique.mockResolvedValue({ id: 43n, action: 'SYSTEM_SETTING_UPDATED', entityType: 'SYSTEM_SETTING', beforeJson: null, afterJson: { key: 'signup.enabled', value: false } });
      await expect(service().restoreSetting('43', 'thử khôi phục', 3)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('validates ops settings before saving', async () => {
      await expect(service().updateOpsSetting('ops.security.loginLockout', { maxAttempts: -1, windowMinutes: 15 }, 3)).rejects.toMatchObject({ statusCode: 400 });
      const ok = await service().updateOpsSetting('ops.security.loginLockout', { maxAttempts: 8, windowMinutes: 10 }, 3);
      expect(ok.value).toEqual({ maxAttempts: 8, windowMinutes: 10 });
    });
  });

  describe('transfer store owner (B5)', () => {
    const input = { newOwnerUserId: 2, reason: 'Chủ cũ chuyển nhượng cửa hàng', actorPassword: ADMIN_PASSWORD, deactivateFormerOwner: false };

    beforeEach(() => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', code: 'A' });
      db.user.findMany.mockResolvedValue([{ id: 1, fullName: 'Owner A', email: 'owner@store-a.test', isActive: true }]);
      db.user.updateMany.mockResolvedValue({ count: 1 });
      db.user.update.mockResolvedValue({});
      db.authSession.updateMany.mockResolvedValue({ count: 3 });
      db.user.count.mockResolvedValue(1);
    });

    it('demotes the old owner, promotes the staff member, revokes sessions and audits — in one transaction', async () => {
      const result = await service().transferStoreOwner(1, input, 3);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.$queryRaw).toHaveBeenCalled();
      expect(db.user.updateMany).toHaveBeenCalledWith({ where: { storeId: 1, role: 'SHOP_OWNER' }, data: { role: 'WAREHOUSE_STAFF' } });
      expect(db.user.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { role: 'SHOP_OWNER' } });
      expect(db.authSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: { in: [2, 1] }, revokedAt: null } }));
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'STORE_OWNER_TRANSFERRED', storeId: 1 }) })
      );
      expect(result).toMatchObject({ newOwner: { id: 2 }, revokedSessions: 3 });
    });

    it('requires the admin password', async () => {
      await expect(service().transferStoreOwner(1, { ...input, actorPassword: 'wrong' }, 3)).rejects.toMatchObject({ statusCode: 403 });
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a user from another store', async () => {
      await expect(service().transferStoreOwner(1, { ...input, newOwnerUserId: 4 }, 3)).rejects.toMatchObject({ statusCode: 400 });
      expect(db.user.updateMany).not.toHaveBeenCalled();
    });

    it('aborts (rolls back) if the single-owner invariant would break', async () => {
      db.user.count.mockResolvedValue(2);
      await expect(service().transferStoreOwner(1, input, 3)).rejects.toMatchObject({ statusCode: 409 });
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('announcements (B2)', () => {
    it('creates one notification per active recipient in chunks and audits the broadcast', async () => {
      const recipients = Array.from({ length: 1200 }, (_, i) => ({ id: i + 10, storeId: (i % 3) + 1 }));
      db.user.findMany.mockResolvedValue(recipients);
      db.notification.createMany.mockImplementation(({ data }: any) => Promise.resolve({ count: data.length }));
      const result = await service().broadcastAnnouncement({ title: 'Bảo trì hệ thống', message: 'Hệ thống bảo trì lúc 23:00 tối nay.' }, 3);
      expect(db.notification.createMany).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ recipients: 1200, storeCount: 3 });
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'ANNOUNCEMENT_SENT' }) })
      );
    });

    it('rejects a broadcast with no recipients', async () => {
      db.user.findMany.mockResolvedValue([]);
      await expect(service().broadcastAnnouncement({ title: 'Xin chào', message: 'Nội dung thử' }, 3)).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
