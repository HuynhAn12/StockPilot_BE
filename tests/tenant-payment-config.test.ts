import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { SecretEncryptionService } from '../src/common/services/secret-encryption.service';
import { prisma } from '../src/config/db';
import { env, isValidAes256Key } from '../src/config/env';

jest.mock('../src/config/db', () => ({
  prisma: {
    store: { findUnique: jest.fn(), findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    storePaymentConfig: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('Tenant context and store payment config foundation', () => {
  const app = createApp();

  const ownerToken = generateAccessToken({
    userId: 1,
    email: 'owner@sandg.test',
    role: 'SHOP_OWNER',
    storeId: 1,
  });
  const staffToken = generateAccessToken({
    userId: 2,
    email: 'staff@sandg.test',
    role: 'WAREHOUSE_STAFF',
    storeId: 1,
  });
  const adminToken = generateAccessToken({
    userId: 3,
    email: 'admin@stockpilot.test',
    role: 'ADMIN',
    storeId: null,
  });
  const inactiveStoreUserToken = generateAccessToken({
    userId: 5,
    email: 'inactive-user@sandg.test',
    role: 'SHOP_OWNER',
    storeId: 1,
  });
  const legacyOwnerToken = generateAccessToken({
    userId: 6,
    email: 'owner@legacy.test',
    role: 'SHOP_OWNER',
    storeId: 6,
  });

  beforeEach(() => {
    env.NODE_ENV = 'test';
    jest.clearAllMocks();

    (prisma.store.findUnique as jest.Mock).mockImplementation(({ where }) => {
      const stores: Record<string, any> = {
        sandg: { id: 1, code: 'sandg', isActive: true },
        storeb: { id: 2, code: 'storeb', isActive: true },
        inactive: { id: 9, code: 'inactive', isActive: false },
      };
      return Promise.resolve(stores[where.code] ?? null);
    });
    (prisma.store.findFirst as jest.Mock).mockImplementation(({ where }) => {
      const stores: Record<string, any> = {
        sand_shop: { id: 6, code: 'sand_shop', isActive: true },
      };
      const codes = where.code.in as string[];
      return Promise.resolve(codes.map((code) => stores[code]).find(Boolean) ?? null);
    });

    (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
      const users: Record<number, any> = {
        1: { id: 1, email: 'owner@sandg.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
        2: { id: 2, email: 'staff@sandg.test', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
        3: { id: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null, isActive: true, store: null },
        5: { id: 5, email: 'inactive-user@sandg.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: false } },
        6: { id: 6, email: 'owner@legacy.test', role: 'SHOP_OWNER', storeId: 6, isActive: true, store: { isActive: true } },
      };
      return Promise.resolve(users[where.id] ?? null);
    });

    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 1n });
    (prisma.storePaymentConfig.findUnique as jest.Mock).mockResolvedValue(null);
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  it('resolves a valid store hostname and allows a matching store user', async () => {
    const response = await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'sandg.stockpilot.vn')
      .set(auth(ownerToken))
      .expect(200);

    expect(response.body.data).toEqual({
      provider: 'PAYOS',
      configured: false,
      active: false,
    });
    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { code: 'sandg' },
      select: { id: true, code: true, isActive: true },
    });
  });

  it('fails safely for unknown and inactive store hostnames', async () => {
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'missing.stockpilot.vn')
      .set(auth(ownerToken))
      .expect(404);

    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'inactive.stockpilot.vn')
      .set(auth(ownerToken))
      .expect(403);
  });

  it('rejects hostname and JWT store mismatches', async () => {
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'storeb.stockpilot.vn')
      .set(auth(ownerToken))
      .expect(403);
  });

  it('keeps localhost usable for tests without a tenant hostname', async () => {
    await request(app).get('/api/v1/store/payment-config/payos').set(auth(ownerToken)).expect(200);
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('allows dev/test tenant header on localhost only outside production', async () => {
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'localhost:5000')
      .set('x-tenant-code', 'sandg')
      .set(auth(ownerToken))
      .expect(200);

    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { code: 'sandg' },
      select: { id: true, code: true, isActive: true },
    });
  });

  it('resolves a canonical tenant slug to a legacy underscore Store.code without changing store isolation', async () => {
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'sand-shop.stockpilot.vn')
      .set(auth(legacyOwnerToken))
      .expect(200);

    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { code: 'sand-shop' },
      select: { id: true, code: true, isActive: true },
    });
    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: { code: { in: ['sand_shop'] } },
      select: { id: true, code: true, isActive: true },
    });

    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'sand-shop.stockpilot.vn')
      .set(auth(ownerToken))
      .expect(403);
  });

  it('requires a resolved tenant for production store APIs and ignores dev tenant headers', async () => {
    env.NODE_ENV = 'production';

    await request(app).get('/api/v1/store/payment-config/payos').set(auth(ownerToken)).expect(403);
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'localhost:5000')
      .set('x-tenant-code', 'sandg')
      .set(auth(ownerToken))
      .expect(403);
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'external.example.com')
      .set(auth(ownerToken))
      .expect(403);

    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('does not resolve reserved production subdomains as store codes', async () => {
    env.NODE_ENV = 'production';

    for (const host of ['api.stockpilot.vn', 'admin.stockpilot.vn', 'app.stockpilot.vn', 'www.stockpilot.vn']) {
      await request(app).get('/api/v1/store/payment-config/payos').set('Host', host).set(auth(ownerToken)).expect(403);
    }

    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('rejects root-domain production store API requests without treating root as a tenant', async () => {
    env.NODE_ENV = 'production';

    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'stockpilot.vn')
      .set(auth(ownerToken))
      .expect(403);

    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('rejects users whose authenticated store is inactive even when hostname resolves', async () => {
    await request(app)
      .get('/api/v1/store/payment-config/payos')
      .set('Host', 'sandg.stockpilot.vn')
      .set(auth(inactiveStoreUserToken))
      .expect(401);
  });

  it('blocks ADMIN and WAREHOUSE_STAFF from configuring PayOS credentials', async () => {
    await request(app)
      .put('/api/v1/store/payment-config/payos')
      .set(auth(staffToken))
      .send({ clientId: 'payos-client', apiKey: 'payos-api-key', checksumKey: 'payos-checksum' })
      .expect(403);

    await request(app)
      .put('/api/v1/store/payment-config/payos')
      .set(auth(adminToken))
      .send({ clientId: 'payos-client', apiKey: 'payos-api-key', checksumKey: 'payos-checksum' })
      .expect(403);
  });

  it('lets SHOP_OWNER create PayOS config without returning or auditing secrets', async () => {
    (prisma.storePaymentConfig.upsert as jest.Mock).mockImplementation(({ create }) =>
      Promise.resolve({
        id: 11,
        storeId: create.storeId,
        provider: create.provider,
        clientIdEncrypted: create.clientIdEncrypted,
        apiKeyEncrypted: create.apiKeyEncrypted,
        checksumKeyEncrypted: create.checksumKeyEncrypted,
        isActive: create.isActive,
        configuredAt: create.configuredAt,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      })
    );

    const response = await request(app)
      .put('/api/v1/store/payment-config/payos')
      .set(auth(ownerToken))
      .send({ clientId: 'payos-client-123', apiKey: 'payos-api-key-secret', checksumKey: 'payos-checksum-secret' })
      .expect(200);

    const bodyText = JSON.stringify(response.body);
    expect(bodyText).not.toContain('payos-api-key-secret');
    expect(bodyText).not.toContain('payos-checksum-secret');
    expect(response.body.data).toMatchObject({
      provider: 'PAYOS',
      configured: true,
      active: true,
      clientIdMasked: 'pay***123',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PAYMENT_CONFIG_CREATED',
          afterJson: expect.anything(),
        }),
      })
    );
    expect(prisma.storePaymentConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId_provider: { storeId: 1, provider: 'PAYOS' } },
        create: expect.objectContaining({ storeId: 1, provider: 'PAYOS' }),
        update: expect.objectContaining({ isActive: true }),
      })
    );
    expect(JSON.stringify((prisma.auditLog.create as jest.Mock).mock.calls)).not.toContain('payos-api-key-secret');
    expect(JSON.stringify((prisma.auditLog.create as jest.Mock).mock.calls)).not.toContain('payos-checksum-secret');
  });

  it('lets SHOP_OWNER update and deactivate PayOS config', async () => {
    (prisma.storePaymentConfig.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 11, isActive: true })
      .mockResolvedValueOnce({ id: 11, isActive: true });
    (prisma.storePaymentConfig.upsert as jest.Mock).mockImplementation(({ update }) =>
      Promise.resolve({
        id: 11,
        storeId: 1,
        provider: 'PAYOS',
        clientIdEncrypted: update.clientIdEncrypted,
        apiKeyEncrypted: update.apiKeyEncrypted,
        checksumKeyEncrypted: update.checksumKeyEncrypted,
        isActive: update.isActive,
        configuredAt: update.configuredAt,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      })
    );
    (prisma.storePaymentConfig.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({
        id: 11,
        storeId: 1,
        provider: 'PAYOS',
        clientIdEncrypted: data.clientIdEncrypted ?? SecretEncryptionService.encrypt('payos-client-123'),
        apiKeyEncrypted: data.apiKeyEncrypted ?? SecretEncryptionService.encrypt('payos-api-key-secret'),
        checksumKeyEncrypted: data.checksumKeyEncrypted ?? SecretEncryptionService.encrypt('payos-checksum-secret'),
        isActive: data.isActive,
        configuredAt: data.configuredAt ?? new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      })
    );

    await request(app)
      .put('/api/v1/store/payment-config/payos')
      .set(auth(ownerToken))
      .send({ clientId: 'payos-client-456', apiKey: 'payos-api-key-new', checksumKey: 'payos-checksum-new' })
      .expect(200);

    await request(app).post('/api/v1/store/payment-config/payos/deactivate').set(auth(ownerToken)).expect(200);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'PAYMENT_CONFIG_UPDATED' }) })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'PAYMENT_CONFIG_DISABLED' }) })
    );
  });

  it('never returns API key or checksum key from GET status', async () => {
    (prisma.storePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      id: 11,
      provider: 'PAYOS',
      clientIdEncrypted: SecretEncryptionService.encrypt('client-visible-only'),
      apiKeyEncrypted: SecretEncryptionService.encrypt('api-key-hidden'),
      checksumKeyEncrypted: SecretEncryptionService.encrypt('checksum-hidden'),
      isActive: true,
      configuredAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    const response = await request(app).get('/api/v1/store/payment-config/payos').set(auth(ownerToken)).expect(200);
    const bodyText = JSON.stringify(response.body);

    expect(bodyText).toContain('cli***nly');
    expect(bodyText).not.toContain('api-key-hidden');
    expect(bodyText).not.toContain('checksum-hidden');
    expect(bodyText).not.toContain('Encrypted');
  });

  it('supports encryption round-trip and rejects tampered payloads safely', () => {
    const encrypted = SecretEncryptionService.encrypt('secret-value');

    expect(SecretEncryptionService.decrypt(encrypted)).toBe('secret-value');
    expect(() => SecretEncryptionService.decrypt(`${encrypted.slice(0, -4)}AAAA`)).toThrow('SECRET_DECRYPTION_FAILED');
  });

  it('validates AES-256 encryption key formats strictly', () => {
    const base64Key = Buffer.alloc(32, 7).toString('base64');
    const hexKey = 'a'.repeat(64);

    expect(isValidAes256Key(base64Key)).toBe(true);
    expect(isValidAes256Key(hexKey)).toBe(true);
    expect(isValidAes256Key('not-base64-but-node-may-decode')).toBe(false);
    expect(isValidAes256Key(`${base64Key.slice(0, -2)}$$`)).toBe(false);
    expect(isValidAes256Key(Buffer.alloc(31, 7).toString('base64'))).toBe(false);
  });
});
