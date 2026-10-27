import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { SecretEncryptionService } from '../src/common/services/secret-encryption.service';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totpCode,
  totpStep,
  verifyTotp,
} from '../src/common/services/totp.service';
import { TwoFactorRequiredError, TwoFactorService } from '../src/common/services/two-factor.service';
import { AdminOpsService } from '../src/modules/admin-ops/admin-ops.service';

const ADMIN_PASSWORD = 'Adm1nPassword!';
const OWNER_PASSWORD = 'Owner1Password!';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    store: { findFirst: jest.fn() },
    auditLog: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    authSession: { create: jest.fn() },
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    aiInteraction: { count: jest.fn() },
    notification: { count: jest.fn() },
    supportTicketAttachment: { aggregate: jest.fn() },
    warehouse: { findMany: jest.fn() },
    category: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    stockItem: { findMany: jest.fn() },
    inventoryBalance: { findMany: jest.fn() },
    stockMovement: { findMany: jest.fn() },
    order: { findMany: jest.fn() },
    returnOrder: { findMany: jest.fn() },
    payment: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn((callback: any) => callback(prisma)),
  },
}));

const db = prisma as any;

const users: Record<number, any> = {
  1: { id: 1, email: 'owner@store-a.test', fullName: 'Owner A', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true }, passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4) },
  2: { id: 2, email: 'staff@store-a.test', fullName: 'Staff A', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4) },
  5: { id: 5, email: 'admin2@stockpilot.test', fullName: 'Admin 2', role: 'ADMIN', storeId: null, isActive: true, store: null, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 4) },
};

/** In-memory system_settings so 2FA state survives across calls within a test. */
let settings: Map<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  settings = new Map();
  db.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id !== undefined) return Promise.resolve(users[where.id] ?? null);
    return Promise.resolve(Object.values(users).find((u) => u.email === where.email) ?? null);
  });
  db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(settings.has(where.key) ? { key: where.key, valueJson: settings.get(where.key) } : null)
  );
  db.systemSetting.upsert.mockImplementation(({ where, create, update }: any) => {
    settings.set(where.key, settings.has(where.key) ? update.valueJson : create.valueJson);
    return Promise.resolve({});
  });
  db.systemSetting.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({ id: 1n });
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.findMany.mockResolvedValue([]);
  db.authSession.create.mockResolvedValue({ id: 1 });
  db.$transaction.mockImplementation((callback: any) => callback(prisma));
  // Deterministic "encryption" so tests do not depend on the machine's encryption key.
  jest.spyOn(SecretEncryptionService, 'encrypt').mockImplementation((s: string) => `enc:${s}`);
  jest.spyOn(SecretEncryptionService, 'decrypt').mockImplementation((s: string) => s.replace(/^enc:/, ''));
});

afterEach(() => jest.restoreAllMocks());

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // Official RFC 6238 Appendix B vectors (SHA-1, secret = ASCII "12345678901234567890", 8 digits)
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');

  it('matches the RFC 6238 test vectors', () => {
    expect(hotp(rfcSecret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(rfcSecret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(rfcSecret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(hotp(rfcSecret, Math.floor(20000000000 / 30), 8)).toBe('65353130');
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    expect(base32Decode(base32Encode(rfcSecret)).equals(rfcSecret)).toBe(true);
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('accepts ±1 step of clock drift and rejects replays', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-10-27T03:00:00Z');
    const previous = totpCode(secret, new Date(now.getTime() - 30000));
    expect(verifyTotp(secret, previous, { now })).toBe(totpStep(now) - 1);
    const current = totpCode(secret, now);
    expect(verifyTotp(secret, current, { now, lastUsedStep: totpStep(now) })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
  });
});

describe('TwoFactorService (C3)', () => {
  const service = () => new TwoFactorService(prisma as any);

  async function enable(userId = 3) {
    const { secret } = await service().startSetup(userId, users[userId].email, ADMIN_PASSWORD);
    const { recoveryCodes } = await service().enable(userId, totpCode(secret));
    return { secret, recoveryCodes };
  }

  it('is off by default', async () => {
    expect(await service().getStatus(3)).toEqual({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0, setupPending: false });
    await expect(service().verifyLoginSecondFactor({ id: 3 }, undefined, 'admin@stockpilot.test', {})).resolves.toBeUndefined();
  });

  it('requires the password to start setup and returns an otpauth URL', async () => {
    await expect(service().startSetup(3, 'admin@stockpilot.test', 'wrong')).rejects.toMatchObject({ statusCode: 403 });
    const result = await service().startSetup(3, 'admin@stockpilot.test', ADMIN_PASSWORD);
    expect(result.otpauthUrl).toMatch(/^otpauth:\/\/totp\/StockPilot%3Aadmin%40stockpilot\.test\?secret=/);
    expect(settings.get('admin2fa:3').enabled).toBe(false);
  });

  it('enables with a valid code, stores only hashes of 10 recovery codes', async () => {
    const { recoveryCodes } = await enable();
    expect(recoveryCodes).toHaveLength(10);
    const stored = settings.get('admin2fa:3');
    expect(stored.enabled).toBe(true);
    expect(stored.secretEncrypted).toMatch(/^enc:/);
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]);
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_2FA_ENABLED' }) }));
  });

  it('rejects a wrong confirmation code', async () => {
    await service().startSetup(3, 'admin@stockpilot.test', ADMIN_PASSWORD);
    await expect(service().enable(3, '000000')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('at login: asks for the code, accepts a valid one, then rejects its replay', async () => {
    const { secret } = await enable();
    await expect(service().verifyLoginSecondFactor({ id: 3 }, undefined, 'admin@stockpilot.test', {})).rejects.toBeInstanceOf(TwoFactorRequiredError);

    // The enable step already consumed the current step; use the next one.
    const next = totpCode(secret, new Date(Date.now() + 30000));
    await expect(service().verifyLoginSecondFactor({ id: 3 }, next, 'admin@stockpilot.test', {})).resolves.toBeUndefined();
    await expect(service().verifyLoginSecondFactor({ id: 3 }, next, 'admin@stockpilot.test', {})).rejects.toMatchObject({
      statusCode: 401,
      details: { twoFactorRequired: true },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_FAILED', afterJson: expect.objectContaining({ reason: 'WRONG_OTP' }) }) })
    );
  });

  it('accepts each recovery code exactly once', async () => {
    const { recoveryCodes } = await enable();
    await expect(service().verifyLoginSecondFactor({ id: 3 }, recoveryCodes[0].toLowerCase(), 'admin@stockpilot.test', {})).resolves.toBeUndefined();
    expect((await service().getStatus(3)).recoveryCodesRemaining).toBe(9);
    await expect(service().verifyLoginSecondFactor({ id: 3 }, recoveryCodes[0], 'admin@stockpilot.test', {})).rejects.toBeInstanceOf(TwoFactorRequiredError);
  });

  it('lets another admin reset 2FA, but not yourself', async () => {
    await enable(5);
    await expect(service().resetForUser(5, 5, ADMIN_PASSWORD, 'mất điện thoại')).rejects.toMatchObject({ statusCode: 403 });
    await service().resetForUser(5, 3, ADMIN_PASSWORD, 'Admin 2 mất điện thoại và mã khôi phục');
    expect(settings.get('admin2fa:5').enabled).toBe(false);
    await expect(service().resetForUser(1, 3, ADMIN_PASSWORD, 'không phải admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('Login with 2FA (integration)', () => {
  const app = createApp();

  it('does not change login for admins without 2FA, nor for shop owners', async () => {
    const admin = await request(app).post('/api/v1/auth/login').send({ email: 'admin@stockpilot.test', password: ADMIN_PASSWORD });
    expect(admin.status).toBe(200);
    const owner = await request(app).post('/api/v1/auth/login').send({ email: 'owner@store-a.test', password: OWNER_PASSWORD });
    expect(owner.status).toBe(200);
  });

  it('requires otpCode once the admin enabled 2FA', async () => {
    const svc = new TwoFactorService(prisma as any);
    const { secret } = await svc.startSetup(3, 'admin@stockpilot.test', ADMIN_PASSWORD);
    await svc.enable(3, totpCode(secret));

    const withoutCode = await request(app).post('/api/v1/auth/login').send({ email: 'admin@stockpilot.test', password: ADMIN_PASSWORD });
    expect(withoutCode.status).toBe(401);
    expect(withoutCode.body.error.details).toEqual({ twoFactorRequired: true });
    expect(db.authSession.create).not.toHaveBeenCalled();

    const withCode = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@stockpilot.test', password: ADMIN_PASSWORD, otpCode: totpCode(secret, new Date(Date.now() + 30000)) });
    expect(withCode.status).toBe(200);
    expect(db.authSession.create).toHaveBeenCalledTimes(1);
  });

  it('exposes the 2FA endpoints to admins only', async () => {
    const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });
    const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });
    expect((await request(app).get('/api/v1/admin/ops/2fa').set({ Authorization: `Bearer ${ownerToken}` })).status).toBe(403);
    const res = await request(app).get('/api/v1/admin/ops/2fa').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });
});

describe('Retention report (C1, dry run)', () => {
  it('only counts — never deletes', async () => {
    db.auditLog.count.mockResolvedValueOnce(1000).mockResolvedValueOnce(300);
    db.aiInteraction.count.mockResolvedValueOnce(50).mockResolvedValueOnce(20);
    db.notification.count.mockResolvedValueOnce(400).mockResolvedValueOnce(250);
    db.supportTicketAttachment.aggregate
      .mockResolvedValueOnce({ _count: { _all: 12 }, _sum: { size: 5_000_000 } })
      .mockResolvedValueOnce({ _count: { _all: 4 }, _sum: { size: 1_000_000 } });
    db.$queryRaw.mockResolvedValue([{ tableName: 'audit_logs', tableRows: 1000n, dataBytes: 2048n, indexBytes: 1024n }]);

    const result = await new AdminOpsService(prisma as any).getRetentionReport({ olderThanDays: 180 });
    expect(result.mode).toBe('DRY_RUN');
    expect(result.candidates.find((c) => c.table === 'audit_logs')).toMatchObject({ total: 1000, olderThanCutoff: 300 });
    expect(result.candidates.find((c) => c.table === 'support_ticket_attachments')).toMatchObject({ totalBytes: 5_000_000, olderThanCutoffBytes: 1_000_000 });
    expect(result.largestTables[0]).toEqual({ table: 'audit_logs', approxRows: 1000, dataBytes: 2048, indexBytes: 1024 });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('still works if information_schema is not readable', async () => {
    db.auditLog.count.mockResolvedValue(0);
    db.aiInteraction.count.mockResolvedValue(0);
    db.notification.count.mockResolvedValue(0);
    db.supportTicketAttachment.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { size: null } });
    db.$queryRaw.mockRejectedValue(new Error('denied'));
    const result = await new AdminOpsService(prisma as any).getRetentionReport({ olderThanDays: 180 });
    expect(result.largestTables).toEqual([]);
  });
});

describe('Store data export (C2, owner only)', () => {
  const app = createApp();
  const ownerToken = generateAccessToken({ userId: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1 });
  const staffToken = generateAccessToken({ userId: 2, email: 'staff@store-a.test', role: 'WAREHOUSE_STAFF', storeId: 1 });
  const adminToken = generateAccessToken({ userId: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null });

  beforeEach(() => {
    db.store.findFirst.mockResolvedValue({ id: 1, name: 'Store A', code: 'store-a', phone: null, address: null, createdAt: new Date() });
    db.user.findMany.mockResolvedValue([{ id: 1, fullName: 'Owner A', email: 'owner@store-a.test', role: 'SHOP_OWNER', isActive: true, createdAt: new Date() }]);
    for (const model of ['warehouse', 'category', 'product', 'stockItem', 'inventoryBalance', 'stockMovement', 'order', 'returnOrder', 'payment']) {
      db[model].findMany.mockResolvedValue([]);
    }
    db.product.findMany.mockResolvedValue([{ id: 7, storeId: 1, name: 'Dầu ăn Neptune 1L' }]);
  });

  it('downloads a JSON file scoped to the owner’s store, without secrets', async () => {
    const res = await request(app).get('/api/v1/store-data/export').set({ Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="stockpilot-store-a-\d{4}-\d{2}-\d{2}\.json"/);
    const body = JSON.parse(res.text);
    expect(body.counts.products).toBe(1);
    expect(res.text).not.toMatch(/passwordHash|refreshToken|apiKey|checksumKey/);
    for (const model of ['warehouse', 'category', 'product', 'stockItem', 'inventoryBalance', 'stockMovement', 'order', 'returnOrder', 'payment']) {
      expect(db[model].findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { storeId: 1 } }));
    }
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'STORE_DATA_EXPORTED', storeId: 1 }) }));
  });

  it('is forbidden for warehouse staff and for admins', async () => {
    expect((await request(app).get('/api/v1/store-data/export').set({ Authorization: `Bearer ${staffToken}` })).status).toBe(403);
    expect((await request(app).get('/api/v1/store-data/export').set({ Authorization: `Bearer ${adminToken}` })).status).toBe(403);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});
