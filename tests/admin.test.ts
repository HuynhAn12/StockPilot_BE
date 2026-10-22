import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/db';
import { AdminService } from '../src/modules/admin/admin.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { assertAiQuota } from '../src/modules/assistant/assistant.controller';
import { HttpMetricsService } from '../src/common/services/http-metrics.service';

const ADMIN_PASSWORD = 'Adm1nPassword!';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    store: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    authSession: {
      groupBy: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    contactLead: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    supportTicket: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    storePaymentConfig: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    order: {
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    aiInteraction: {
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      count: jest.fn(),
    },
    systemSetting: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

const db = prisma as any;

const authUsers: Record<number, any> = {
  1: { id: 1, email: 'owner@store-a.test', fullName: 'Owner A', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
  2: { id: 2, email: 'staff@store-a.test', fullName: 'Staff A', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4) },
};

describe('Admin API', () => {
  const app = createApp();

  const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });
  const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => {
      if (where.id !== undefined) return Promise.resolve(authUsers[where.id] ?? null);
      return Promise.resolve(Object.values(authUsers).find((u) => u.email === where.email) ?? null);
    });
    db.auditLog.create.mockResolvedValue({ id: 1n });
    db.authSession.groupBy.mockResolvedValue([]);
    db.authSession.count.mockResolvedValue(0);
    db.contactLead.groupBy.mockResolvedValue([]);
    db.supportTicket.groupBy.mockResolvedValue([]);
    db.store.findMany.mockResolvedValue([]);
    db.systemSetting.findUnique.mockResolvedValue(null);
    db.systemSetting.findMany.mockResolvedValue([]);
  });

  describe('access control', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/dashboard');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects shop owners from every admin endpoint', async () => {
      const res = await request(app).get('/api/v1/admin/users').set(auth(ownerToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(db.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/dashboard', () => {
    it('returns platform counters and serialized recent audit logs', async () => {
      db.store.count.mockResolvedValueOnce(5).mockResolvedValueOnce(4).mockResolvedValueOnce(2);
      db.user.groupBy.mockResolvedValue([
        { role: 'SHOP_OWNER', _count: { _all: 5 } },
        { role: 'WAREHOUSE_STAFF', _count: { _all: 12 } },
        { role: 'ADMIN', _count: { _all: 1 } },
      ]);
      db.user.count.mockResolvedValue(2);
      db.auditLog.count.mockResolvedValue(37);
      db.contactLead.count.mockResolvedValue(3);
      db.auditLog.findMany.mockResolvedValue([
        { id: 99n, action: 'LOGIN', entityType: 'USER', createdAt: new Date(), user: null, store: null },
      ]);
      db.contactLead.groupBy.mockResolvedValue([
        { status: 'NEW', _count: { _all: 3 } },
        { status: 'CONTACTED', _count: { _all: 2 } },
        { status: 'CONVERTED', _count: { _all: 5 } },
      ]);
      db.authSession.count.mockResolvedValue(8);
      db.supportTicket.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: { _all: 3 } },
        { status: 'RESOLVED', _count: { _all: 7 } },
      ]);

      const res = await request(app).get('/api/v1/admin/dashboard').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.stores).toEqual({ total: 5, active: 4, inactive: 1 });
      expect(res.body.data.users).toEqual({
        total: 18,
        active: 16,
        locked: 2,
        byRole: { SHOP_OWNER: 5, WAREHOUSE_STAFF: 12, ADMIN: 1 },
      });
      expect(res.body.data.auditEventsToday).toBe(37);
      expect(res.body.data.newLeads).toBe(3);
      expect(res.body.data.recentAuditLogs[0].id).toBe('99');
      expect(res.body.data.growth).toEqual({
        leads30d: 3,
        leadsByStatus: { NEW: 3, CONTACTED: 2, CONVERTED: 5, REJECTED: 0 },
        conversionRate: 50,
        newStores30d: 2,
        idleStores: [],
      });
      expect(res.body.data.supportSummary).toEqual([
        { status: 'OPEN', _count: { _all: 3 } },
        { status: 'RESOLVED', _count: { _all: 7 } },
      ]);
      expect(res.body.data.activeSessionsCount).toBe(8);
    });

    it('detects idle stores based on owner last login and store creation date', async () => {
      const now = new Date();
      const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      db.store.count.mockResolvedValue(10);
      db.user.groupBy.mockResolvedValue([]);
      db.user.count.mockResolvedValue(0);
      db.auditLog.count.mockResolvedValue(0);
      db.contactLead.count.mockResolvedValue(0);
      db.auditLog.findMany.mockResolvedValue([]);
      db.contactLead.groupBy.mockResolvedValue([]);
      db.supportTicket.groupBy.mockResolvedValue([]);
      db.authSession.count.mockResolvedValue(2);

      // 4 stores to test all idle branches:
      // 1. Idle: Created 30 days ago, owner logged in 20 days ago (> 14 days)
      // 2. Idle: Created 20 days ago, owner never logged in (> 14 days)
      // 3. Active: Created 30 days ago, owner logged in 2 days ago (<= 14 days)
      // 4. Active: Created 5 days ago, owner never logged in (<= 14 days)
      db.store.findMany.mockResolvedValue([
        {
          id: 101,
          name: 'Idle Store With Old Login',
          code: 'IDLE01',
          phone: '0901111111',
          address: '123 Test St',
          isActive: true,
          createdAt: thirtyDaysAgo,
          users: [
            {
              id: 51,
              fullName: 'Old Owner',
              email: 'old@idle.test',
              createdAt: thirtyDaysAgo,
              sessions: [{ createdAt: twentyDaysAgo }],
            },
          ],
        },
        {
          id: 102,
          name: 'Idle Store Never Logged In',
          code: 'IDLE02',
          phone: null,
          address: null,
          isActive: true,
          createdAt: twentyDaysAgo,
          users: [
            {
              id: 52,
              fullName: 'Never Logged In Owner',
              email: 'never@idle.test',
              createdAt: twentyDaysAgo,
              sessions: [],
            },
          ],
        },
        {
          id: 103,
          name: 'Active Store Recent Login',
          code: 'ACT01',
          phone: '0902222222',
          address: '456 Active Ave',
          isActive: true,
          createdAt: thirtyDaysAgo,
          users: [
            {
              id: 53,
              fullName: 'Recent Owner',
              email: 'recent@active.test',
              createdAt: thirtyDaysAgo,
              sessions: [{ createdAt: twoDaysAgo }],
            },
          ],
        },
        {
          id: 104,
          name: 'New Store No Login Yet',
          code: 'NEW01',
          phone: null,
          address: null,
          isActive: true,
          createdAt: fiveDaysAgo,
          users: [
            {
              id: 54,
              fullName: 'New Owner',
              email: 'new@fresh.test',
              createdAt: fiveDaysAgo,
              sessions: [],
            },
          ],
        },
      ]);

      const res = await request(app).get('/api/v1/admin/dashboard').set(auth(adminToken));

      expect(res.status).toBe(200);
      const idle = res.body.data.growth.idleStores;
      expect(idle).toHaveLength(2);

      const idle1 = idle.find((s: any) => s.id === 101);
      expect(idle1).toBeDefined();
      expect(idle1.code).toBe('IDLE01');
      expect(idle1.daysIdle).toBeGreaterThanOrEqual(19);
      expect(idle1.owner.email).toBe('old@idle.test');

      const idle2 = idle.find((s: any) => s.id === 102);
      expect(idle2).toBeDefined();
      expect(idle2.code).toBe('IDLE02');
      expect(idle2.lastLoginAt).toBeNull();
      expect(idle2.daysIdle).toBeGreaterThanOrEqual(19);
      expect(idle2.owner.email).toBe('never@idle.test');

      // Non-idle stores should not be present
      expect(idle.find((s: any) => s.id === 103)).toBeUndefined();
      expect(idle.find((s: any) => s.id === 104)).toBeUndefined();
    });

    it('calculates conversion rate safely when totalLeads is 0', async () => {
      db.store.count.mockResolvedValue(0);
      db.user.groupBy.mockResolvedValue([]);
      db.user.count.mockResolvedValue(0);
      db.auditLog.count.mockResolvedValue(0);
      db.contactLead.count.mockResolvedValue(0);
      db.auditLog.findMany.mockResolvedValue([]);
      db.contactLead.groupBy.mockResolvedValue([]);
      db.supportTicket.groupBy.mockResolvedValue([]);
      db.authSession.count.mockResolvedValue(0);
      db.store.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/v1/admin/dashboard').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.growth.conversionRate).toBe(0);
      expect(res.body.data.growth.leads30d).toBe(0);
      expect(res.body.data.growth.leadsByStatus).toEqual({
        NEW: 0,
        CONTACTED: 0,
        CONVERTED: 0,
        REJECTED: 0,
      });
    });
  });

  describe('users', () => {
    it('lists users across stores with filters and last login', async () => {
      const lastLogin = new Date('2026-10-20T08:00:00.000Z');
      db.user.findMany.mockResolvedValue([{ id: 2, email: 'staff@store-a.test', role: 'WAREHOUSE_STAFF', store: { id: 1 } }]);
      db.user.count.mockResolvedValue(1);
      db.authSession.groupBy.mockResolvedValue([{ userId: 2, _max: { createdAt: lastLogin } }]);

      const res = await request(app)
        .get('/api/v1/admin/users?role=WAREHOUSE_STAFF&search=staff&isActive=true&page=1&limit=10')
        .set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            role: 'WAREHOUSE_STAFF',
            isActive: true,
            OR: [{ fullName: { contains: 'staff' } }, { email: { contains: 'staff' } }],
          },
          skip: 0,
          take: 10,
        })
      );
      expect(res.body.data[0].lastLoginAt).toBe(lastLogin.toISOString());
      expect(res.body.pagination).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });

    it('treats role=ALL as no role filter', async () => {
      db.user.findMany.mockResolvedValue([]);
      db.user.count.mockResolvedValue(0);

      const res = await request(app).get('/api/v1/admin/users?role=ALL').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(db.user.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('forbids an admin from locking their own account', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/users/3/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Self lock attempt' });

      expect(res.status).toBe(403);
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('locks a user, revokes all sessions and writes an audit log in one transaction', async () => {
      db.user.update.mockResolvedValue({ ...authUsers[2], isActive: false });
      db.authSession.updateMany.mockResolvedValue({ count: 2 });

      const res = await request(app)
        .patch('/api/v1/admin/users/2/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Brute force suspected' });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
      expect(res.body.data.revokedSessions).toBe(2);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 }, data: { isActive: false } }));
      expect(db.authSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 2, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'USER_LOCKED', entityType: 'USER', entityId: '2', userId: 3, storeId: 1 }),
      });
    });

    it('does not revoke sessions when unlocking', async () => {
      db.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 2 ? { ...authUsers[2], isActive: false } : authUsers[where.id] ?? null)
      );
      db.user.update.mockResolvedValue({ ...authUsers[2], isActive: true });

      const res = await request(app).patch('/api/v1/admin/users/2/status').set(auth(adminToken)).send({ isActive: true });

      expect(res.status).toBe(200);
      expect(db.authSession.updateMany).not.toHaveBeenCalled();
      expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'USER_UNLOCKED' }) });
    });

    it('returns 404 for an unknown user', async () => {
      const res = await request(app).patch('/api/v1/admin/users/999/status').set(auth(adminToken)).send({ isActive: false, reason: 'Unknown user test' });
      expect(res.status).toBe(404);
    });

    it('creates an admin account without a store and never returns the password hash', async () => {
      db.user.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 10, email: data.email, fullName: data.fullName, role: data.role, isActive: true, storeId: data.storeId })
      );

      const res = await request(app)
        .post('/api/v1/admin/users')
        .set(auth(adminToken))
        .send({ fullName: 'Ops Admin', email: 'Ops@StockPilot.test', password: 'Sup3rSecret!', actorPassword: ADMIN_PASSWORD });

      expect(res.status).toBe(201);
      expect(db.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'ops@stockpilot.test', role: 'ADMIN', storeId: null }),
        })
      );
      expect(db.user.create.mock.calls[0][0].data.passwordHash).not.toBe('Sup3rSecret!');
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'USER_CREATED' }) });
    });

    it('rejects creating an admin with an existing email', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set(auth(adminToken))
        .send({ fullName: 'Dup', email: 'staff@store-a.test', password: 'Sup3rSecret!', actorPassword: ADMIN_PASSWORD });

      expect(res.status).toBe(409);
      expect(db.user.create).not.toHaveBeenCalled();
    });

    it('rejects unknown fields such as role on admin creation', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set(auth(adminToken))
        .send({ fullName: 'X Admin', email: 'x@stockpilot.test', password: 'Sup3rSecret!', storeId: 1 });

      expect(res.status).toBe(400);
    });
  });

  describe('stores', () => {
    it('lists stores with owner and scale counters', async () => {
      db.store.findMany.mockResolvedValue([
        {
          id: 1,
          name: 'Store A',
          code: 'store-a',
          isActive: true,
          users: [{ id: 1, fullName: 'Owner A', email: 'owner@store-a.test', isActive: true }],
          _count: { users: 3, products: 20, stockItems: 45, orders: 120 },
        },
      ]);
      db.store.count.mockResolvedValue(1);
      db.storePaymentConfig.count.mockResolvedValue(0);
      db.storePaymentConfig.findMany.mockResolvedValue([]);
      db.user.findMany.mockResolvedValue([{ id: 1, storeId: 1 }]);
      db.authSession.groupBy.mockResolvedValue([{ userId: 1, _max: { createdAt: new Date('2026-10-20T00:00:00Z') } }]);
      db.order.groupBy.mockImplementation(({ _count }: any) =>
        Promise.resolve(
          _count
            ? [{ storeId: 1, _count: { _all: 8 } }]
            : [{ storeId: 1, _max: { createdAt: new Date('2026-10-21T00:00:00Z') } }]
        )
      );

      const res = await request(app).get('/api/v1/admin/stores?isActive=true').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(db.store.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
      expect(res.body.data[0].owner.email).toBe('owner@store-a.test');
      expect(res.body.data[0].stats).toEqual({
        users: 3,
        products: 20,
        skus: 45,
        orders: 120,
        ordersLast30Days: 8,
        lastOrderAt: '2026-10-21T00:00:00.000Z',
      });
      expect(res.body.data[0].lastActiveAt).toBe('2026-10-20T00:00:00.000Z');
      expect(res.body.summary).toEqual(expect.objectContaining({ total: 1, payosActive: 0 }));
      expect(res.body.data[0]).not.toHaveProperty('_count');
    });

    it('reports PayOS per store instead of assuming it is enabled', async () => {
      const base = { name: 'S', isActive: true, users: [], _count: { users: 1, products: 0, stockItems: 0, orders: 0 } };
      db.store.findMany.mockResolvedValue([
        { ...base, id: 1, code: 'a' },
        { ...base, id: 2, code: 'b' },
        { ...base, id: 3, code: 'c' },
      ]);
      db.store.count.mockResolvedValue(3);
      db.storePaymentConfig.count.mockResolvedValue(1);
      db.storePaymentConfig.findMany.mockResolvedValue([
        { storeId: 1, isActive: true },
        { storeId: 2, isActive: false },
      ]);
      db.user.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/v1/admin/stores').set(auth(adminToken));

      expect(res.body.data.map((s: any) => s.payos)).toEqual(['ACTIVE', 'DISABLED', 'NOT_CONFIGURED']);
    });

    it('returns store overview without payment credentials', async () => {
      db.store.findUnique.mockResolvedValue({
        id: 1,
        name: 'Store A',
        code: 'store-a',
        isActive: true,
        _count: { products: 20, stockItems: 45, orders: 120, warehouses: 1 },
      });
      db.user.findMany.mockResolvedValue([{ id: 1, fullName: 'Owner A' }]);
      db.user.groupBy.mockResolvedValue([
        { role: 'SHOP_OWNER', _count: { _all: 1 } },
        { role: 'WAREHOUSE_STAFF', _count: { _all: 2 } },
      ]);
      db.storePaymentConfig.findMany.mockResolvedValue([{ provider: 'PAYOS', isActive: true, configuredAt: null }]);
      db.order.findFirst.mockResolvedValue(null);
      db.order.count.mockResolvedValue(8);

      const res = await request(app).get('/api/v1/admin/stores/1').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.stats).toEqual(
        expect.objectContaining({ owners: 1, staff: 2, skus: 45, ordersLast30Days: 8, lastOrderAt: null })
      );
      expect(db.storePaymentConfig.findMany).toHaveBeenCalledWith({
        where: { storeId: 1 },
        select: { provider: true, isActive: true, configuredAt: true },
      });
    });

    it('locks a store and revokes the sessions of all its users', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', isActive: true });
      db.store.update.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', isActive: false });
      db.authSession.updateMany.mockResolvedValue({ count: 4 });

      const res = await request(app)
        .patch('/api/v1/admin/stores/1/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Subscription expired', actorPassword: ADMIN_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.revokedSessions).toBe(4);
      expect(db.authSession.updateMany).toHaveBeenCalledWith({
        where: { revokedAt: null, user: { storeId: 1 } },
        data: { revokedAt: expect.any(Date) },
      });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'STORE_LOCKED', entityType: 'STORE', storeId: 1 }),
      });
    });

    it('is a no-op when the store already has the requested status', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', isActive: true });

      const res = await request(app).patch('/api/v1/admin/stores/1/status').set(auth(adminToken)).send({ isActive: true });

      expect(res.status).toBe(200);
      expect(db.store.update).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('audit logs', () => {
    it('filters by store, action and date range', async () => {
      db.auditLog.findMany.mockResolvedValue([{ id: 5n, action: 'CANCEL_ORDER', user: null, store: null }]);
      db.auditLog.count.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs?storeId=2&action=ORDER&from=2026-10-01T00:00:00.000Z&to=2026-10-31T23:59:59.999Z')
        .set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(db.auditLog.findMany.mock.calls[0][0].where).toEqual({
        storeId: 2,
        action: { contains: 'ORDER' },
        createdAt: { gte: new Date('2026-10-01T00:00:00.000Z'), lte: new Date('2026-10-31T23:59:59.999Z') },
      });
      expect(res.body.data[0].id).toBe('5');
    });

    it('filters by actor role on the server so pagination stays correct', async () => {
      db.auditLog.findMany.mockResolvedValue([]);
      db.auditLog.count.mockResolvedValue(0);

      await request(app).get('/api/v1/admin/audit-logs?actorRole=SHOP_OWNER').set(auth(adminToken));
      expect(db.auditLog.findMany.mock.calls[0][0].where).toEqual({ user: { is: { role: 'SHOP_OWNER' } } });

      await request(app).get('/api/v1/admin/audit-logs?actorRole=SYSTEM').set(auth(adminToken));
      expect(db.auditLog.findMany.mock.calls[1][0].where).toEqual({ userId: null });
    });

    it('rejects an inverted date range', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs?from=2026-10-31&to=2026-10-01')
        .set(auth(adminToken));
      expect(res.status).toBe(400);
    });

    it('keeps the legacy /audit-logs path working for admins only', async () => {
      db.auditLog.findMany.mockResolvedValue([]);
      db.auditLog.count.mockResolvedValue(0);

      const adminRes = await request(app).get('/api/v1/audit-logs').set(auth(adminToken));
      const ownerRes = await request(app).get('/api/v1/audit-logs').set(auth(ownerToken));

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.data).toEqual([]);
      expect(ownerRes.status).toBe(403);
    });

    it('exports CSV with BOM, escapes formulas and records the export', async () => {
      db.auditLog.findMany.mockResolvedValue([
        {
          id: 7n,
          createdAt: new Date('2026-10-21T01:02:03.000Z'),
          action: 'USER_UPDATED',
          entityType: 'USER',
          entityId: '=HYPERLINK("http://evil")',
          ipAddress: '1.2.3.4',
          beforeJson: null,
          afterJson: { fullName: 'Nguyễn Văn "A"' },
          user: { id: 3, fullName: 'Admin', email: 'admin@stockpilot.test', role: 'ADMIN' },
          store: { id: 1, name: 'Store A', code: 'store-a' },
        },
      ]);

      const res = await request(app).get('/api/v1/admin/audit-logs/export?storeId=1').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-logs-\d{4}-\d{2}-\d{2}\.csv"/);
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(res.text).toContain('Nguyễn Văn \\""A\\""');
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'AUDIT_LOG_EXPORTED', userId: 3 }),
      });
    });
  });

  describe('GET /admin/ai-usage', () => {
    it('aggregates totals and per-store usage', async () => {
      db.aiInteraction.aggregate.mockResolvedValue({
        _count: { _all: 10 },
        _avg: { latencyMs: 812.4 },
        _sum: { inputTokens: 1000, outputTokens: 2000 },
      });
      db.aiInteraction.groupBy
        .mockResolvedValueOnce([
          { status: 'SUCCESS', _count: { _all: 8 } },
          { status: 'FAILED', _count: { _all: 1 } },
          { status: 'TIMEOUT', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { storeId: 1, _count: { _all: 7 }, _avg: { latencyMs: 700 }, _sum: { inputTokens: 600, outputTokens: 1200 } },
          { storeId: 2, _count: { _all: 3 }, _avg: { latencyMs: 1000 }, _sum: { inputTokens: 400, outputTokens: 800 } },
        ])
        .mockResolvedValueOnce([
          { storeId: 1, status: 'SUCCESS', _count: { _all: 7 } },
          { storeId: 2, status: 'FAILED', _count: { _all: 1 } },
          { storeId: 2, status: 'TIMEOUT', _count: { _all: 1 } },
          { storeId: 2, status: 'SUCCESS', _count: { _all: 1 } },
        ]);
      db.store.findMany.mockResolvedValue([
        { id: 1, name: 'Store A', code: 'store-a' },
        { id: 2, name: 'Store B', code: 'store-b' },
      ]);

      const res = await request(app).get('/api/v1/admin/ai-usage').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.totals).toEqual({
        interactions: 10,
        SUCCESS: 8,
        FAILED: 1,
        TIMEOUT: 1,
        errorRate: 0.2,
        avgLatencyMs: 812,
        inputTokens: 1000,
        outputTokens: 2000,
      });
      expect(res.body.data.byStore[0]).toEqual(expect.objectContaining({ interactions: 7, failed: 0 }));
      expect(res.body.data.byStore[1]).toEqual(expect.objectContaining({ interactions: 3, failed: 2 }));
    });
  });

  describe('GET /admin/system/config-status', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('reports configuration presence without leaking secret values', async () => {
      process.env.SMTP_USER = 'mailer@stockpilot.test';
      process.env.SMTP_PASS = 'super-secret-smtp-pass';
      process.env.CLOUDINARY_CLOUD_NAME = 'cloud';
      process.env.CLOUDINARY_API_KEY = 'cloud-key-123';
      process.env.CLOUDINARY_API_SECRET = 'cloud-secret-456';
      db.storePaymentConfig.count.mockResolvedValue(2);
      db.authSession.count.mockResolvedValue(9);

      const res = await request(app).get('/api/v1/admin/system/config-status').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.integrations.smtp.configured).toBe(true);
      expect(res.body.data.integrations.cloudinary.configured).toBe(true);
      expect(res.body.data.integrations.payos.storesConfigured).toBe(2);
      expect(res.body.data.auth.activeSessions).toBe(9);

      const body = JSON.stringify(res.body);
      for (const secret of ['super-secret-smtp-pass', 'cloud-key-123', 'cloud-secret-456']) {
        expect(body).not.toContain(secret);
      }
    });
  });

  describe('production safeguards', () => {
    it('requires a reason before locking a user', async () => {
      const res = await request(app).patch('/api/v1/admin/users/2/status').set(auth(adminToken)).send({ isActive: false });

      expect(res.status).toBe(400);
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('does not require a reason to unlock', async () => {
      db.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 2 ? { ...authUsers[2], isActive: false } : authUsers[where.id] ?? null)
      );
      db.user.update.mockResolvedValue({ ...authUsers[2], isActive: true });

      const res = await request(app).patch('/api/v1/admin/users/2/status').set(auth(adminToken)).send({ isActive: true });

      expect(res.status).toBe(200);
    });

    it('rejects locking a store with a wrong confirmation password', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', isActive: true });

      const res = await request(app)
        .patch('/api/v1/admin/stores/1/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Subscription expired', actorPassword: 'wrong-password' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Mật khẩu xác nhận không đúng');
      expect(db.store.update).not.toHaveBeenCalled();
    });

    it('asks for the confirmation password when locking a store without one', async () => {
      db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', isActive: true });

      const res = await request(app)
        .patch('/api/v1/admin/stores/1/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Subscription expired' });

      expect(res.status).toBe(400);
      expect(db.store.update).not.toHaveBeenCalled();
    });

    it('requires the confirmation password to lock another admin but not a shop user', async () => {
      const otherAdmin = { id: 4, email: 'ops@stockpilot.test', fullName: 'Ops', role: 'ADMIN', storeId: null, isActive: true, store: null };
      db.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 4 ? otherAdmin : authUsers[where.id] ?? null)
      );

      const res = await request(app)
        .patch('/api/v1/admin/users/4/status')
        .set(auth(adminToken))
        .send({ isActive: false, reason: 'Left the company' });

      expect(res.status).toBe(400);
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('rejects creating an admin without confirming the current password', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set(auth(adminToken))
        .send({ fullName: 'Ops Admin', email: 'ops@stockpilot.test', password: 'Sup3rSecret!' });

      expect(res.status).toBe(400);
      expect(db.user.create).not.toHaveBeenCalled();
    });
  });

  describe('user support actions', () => {
    it('signs a user out of every device without locking the account', async () => {
      db.authSession.updateMany.mockResolvedValue({ count: 3 });

      const res = await request(app)
        .post('/api/v1/admin/users/2/revoke-sessions')
        .set(auth(adminToken))
        .send({ reason: 'Lost phone reported by owner' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ userId: 2, revokedSessions: 3 });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'USER_SESSIONS_REVOKED', entityId: '2', userId: 3 }),
      });
    });

    it('refuses to revoke the acting admin own sessions', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users/3/revoke-sessions')
        .set(auth(adminToken))
        .send({ reason: 'Testing self revoke' });

      expect(res.status).toBe(403);
    });

    it('sends a reset code through the forgot-password flow and never returns the code', async () => {
      const authService = {
        forgotPassword: jest.fn().mockResolvedValue({ expiresAt: new Date(), otp: '123456', resetToken: 'tok', sent: true, simulated: false }),
      } as unknown as AuthService;

      const result = await new AdminService().sendPasswordReset(2, 3, {}, authService);

      expect(authService.forgotPassword).toHaveBeenCalledWith({ email: 'staff@store-a.test' });
      expect(result).toEqual(expect.objectContaining({ email: 'staff@store-a.test', emailSent: true }));
      expect(JSON.stringify(result)).not.toContain('123456');
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'PASSWORD_RESET_SENT_BY_ADMIN', entityId: '2' }),
      });
    });

    it('does not send a reset code to a locked account', async () => {
      db.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 2 ? { ...authUsers[2], isActive: false } : authUsers[where.id] ?? null)
      );

      const res = await request(app).post('/api/v1/admin/users/2/password-reset').set(auth(adminToken));

      expect(res.status).toBe(409);
    });
  });

  describe('system settings', () => {
    it('lists every known setting with its default', async () => {
      const res = await request(app).get('/api/v1/admin/system/settings').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.map((item: any) => item.key)).toEqual(['signup.enabled', 'maintenance.banner', 'ai.dailyQuotaPerStore']);
      expect(res.body.data[0].value).toBe(true);
    });

    it('validates the value against the setting schema', async () => {
      const res = await request(app)
        .put('/api/v1/admin/system/settings/ai.dailyQuotaPerStore')
        .set(auth(adminToken))
        .send({ value: -5 });

      expect(res.status).toBe(400);
      expect(db.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects unknown setting keys', async () => {
      const res = await request(app).put('/api/v1/admin/system/settings/payments.disabled').set(auth(adminToken)).send({ value: true });

      expect(res.status).toBe(400);
    });

    it('saves a setting and records the before/after values', async () => {
      const res = await request(app)
        .put('/api/v1/admin/system/settings/signup.enabled')
        .set(auth(adminToken))
        .send({ value: false });

      expect(res.status).toBe(200);
      expect(db.systemSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'signup.enabled' }, update: { valueJson: false, updatedById: 3 } })
      );
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SYSTEM_SETTING_UPDATED',
          beforeJson: { key: 'signup.enabled', value: true },
          afterJson: { key: 'signup.enabled', value: false },
        }),
      });
    });

    it('blocks new store sign-ups when sign-up is disabled', async () => {
      const fakeDb = { systemSetting: { findUnique: jest.fn().mockResolvedValue({ valueJson: false }) } } as any;

      await expect(new AuthService(fakeDb).sendRegisterOtp({ email: 'new@shop.test', storeCode: 'new-shop' } as any)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('enforces the daily AI quota per store', async () => {
      db.systemSetting.findUnique.mockResolvedValue({ valueJson: 5 });
      db.aiInteraction.count.mockResolvedValue(5);

      await expect(assertAiQuota(1)).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
      expect(db.aiInteraction.count).toHaveBeenCalledWith({
        where: { storeId: 1, createdAt: { gte: expect.any(Date), lt: expect.any(Date) } },
      });
    });

    it('treats a quota of 0 as unlimited', async () => {
      await expect(assertAiQuota(1)).resolves.toBeUndefined();
      expect(db.aiInteraction.count).not.toHaveBeenCalled();
    });

    it('exposes the announcement publicly only while it is enabled', async () => {
      db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.key === 'maintenance.banner' ? { valueJson: { enabled: true, message: 'Bảo trì 22h' } } : null)
      );

      const res = await request(app).get('/api/v1/public/platform-status');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ announcement: 'Bảo trì 22h', signupEnabled: true });
    });
  });

  describe('system health', () => {
    it('reports database status and request metrics', async () => {
      HttpMetricsService.reset();
      db.$queryRaw.mockResolvedValue([{ 1: 1 }]);

      const res = await request(app).get('/api/v1/admin/system/health').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.database.status).toBe('UP');
      expect(res.body.data.http).toEqual(expect.objectContaining({ serverErrors: 0, recentServerErrors: [] }));
    });

    it('reports the database as DOWN when the ping fails', async () => {
      db.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const res = await request(app).get('/api/v1/admin/system/health').set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.database).toEqual({ status: 'DOWN', latencyMs: null });
    });

    it('counts server errors per hour and keeps the most recent ones', () => {
      HttpMetricsService.reset();
      const now = Date.UTC(2026, 9, 22, 10, 30);
      HttpMetricsService.record({ method: 'GET', path: '/a', statusCode: 200, latencyMs: 10 }, now);
      HttpMetricsService.record({ method: 'POST', path: '/b', statusCode: 500, latencyMs: 30, requestId: 'r1' }, now);
      HttpMetricsService.record({ method: 'GET', path: '/old', statusCode: 500, latencyMs: 5 }, now - 25 * 60 * 60 * 1000);

      const snap = HttpMetricsService.snapshot(now);

      expect(snap.requests).toBe(2);
      expect(snap.serverErrors).toBe(1);
      expect(snap.errorRate).toBe(0.5);
      expect(snap.avgLatencyMs).toBe(20);
      expect(snap.recentServerErrors[0]).toEqual(expect.objectContaining({ path: '/b', requestId: 'r1' }));
    });
  });
});

describe('Admin edits', () => {
  const app = createApp();
  const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });
  const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(authUsers[where.id] ?? null));
    db.auditLog.create.mockResolvedValue({ id: 1n });
  });

  it('renames a user and records the before/after name', async () => {
    db.user.update.mockResolvedValue({ ...authUsers[2], fullName: 'Trần Thị Mai' });

    const res = await request(app).patch('/api/v1/admin/users/2').set(auth(adminToken)).send({ fullName: 'Trần Thị Mai' });

    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 }, data: { fullName: 'Trần Thị Mai' } }));
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'USER_UPDATED', beforeJson: { fullName: 'Staff A' }, afterJson: { fullName: 'Trần Thị Mai' } }),
    });
  });

  it('does not let admins change email or role through the profile endpoint', async () => {
    const res = await request(app).patch('/api/v1/admin/users/2').set(auth(adminToken)).send({ fullName: 'X Y', role: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('edits store contact details, logs only changed fields, and never changes the store code', async () => {
    db.store.findUnique.mockResolvedValue({ id: 1, name: 'Store A', phone: '0901', address: null });
    db.store.update.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', phone: '0912345678', address: 'Đà Nẵng' });

    const res = await request(app)
      .patch('/api/v1/admin/stores/1')
      .set(auth(adminToken))
      .send({ name: 'Store A', phone: '0912345678', address: 'Đà Nẵng' });

    expect(res.status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'STORE_UPDATED',
        beforeJson: { phone: '0901', address: null },
        afterJson: { phone: '0912345678', address: 'Đà Nẵng' },
      }),
    });

    const codeChange = await request(app).patch('/api/v1/admin/stores/1').set(auth(adminToken)).send({ code: 'hacked' });
    expect(codeChange.status).toBe(400);
  });

  it('filters stores by PayOS state', async () => {
    db.store.findMany.mockResolvedValue([]);
    db.store.count.mockResolvedValue(0);
    db.storePaymentConfig.count.mockResolvedValue(0);
    db.storePaymentConfig.findMany.mockResolvedValue([]);

    await request(app).get('/api/v1/admin/stores?payos=NOT_CONFIGURED').set(auth(adminToken));
    expect(db.store.findMany.mock.calls[0][0].where).toEqual({ paymentConfigs: { none: { provider: 'PAYOS' } } });

    await request(app).get('/api/v1/admin/stores?payos=DISABLED').set(auth(adminToken));
    expect(db.store.findMany.mock.calls[1][0].where).toEqual({ paymentConfigs: { some: { provider: 'PAYOS', isActive: false } } });

    const bad = await request(app).get('/api/v1/admin/stores?payos=MOMO').set(auth(adminToken));
    expect(bad.status).toBe(400);
  });

  it('rejects shop owners on admin edit endpoints', async () => {
    const res = await request(app).patch('/api/v1/admin/stores/1').set(auth(ownerToken)).send({ name: 'Mine now' });
    expect(res.status).toBe(403);
  });
});
