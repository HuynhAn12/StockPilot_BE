import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

describe('API Integration & Cross-Store Security', () => {
  const app = createApp();

  const tokenStore1Owner = generateAccessToken({
    userId: 1,
    email: 'owner1@store1.com',
    role: 'SHOP_OWNER',
    storeId: 1,
  });

  const tokenStore2Staff = generateAccessToken({
    userId: 2,
    email: 'staff2@store2.com',
    role: 'WAREHOUSE_STAFF',
    storeId: 2,
  });

  const tokenAdmin = generateAccessToken({
    userId: 3,
    email: 'admin@stockpilot.com',
    role: 'ADMIN',
    storeId: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.id === 1) {
        return Promise.resolve({
          id: 1,
          email: 'owner1@store1.com',
          role: 'SHOP_OWNER',
          storeId: 1,
          isActive: true,
          store: { isActive: true },
        });
      }
      if (where.id === 2) {
        return Promise.resolve({
          id: 2,
          email: 'staff2@store2.com',
          role: 'WAREHOUSE_STAFF',
          storeId: 2,
          isActive: true,
          store: { isActive: true },
        });
      }
      if (where.id === 3) {
        return Promise.resolve({
          id: 3,
          email: 'admin@stockpilot.com',
          role: 'ADMIN',
          storeId: null,
          isActive: true,
          store: null,
        });
      }
      return Promise.resolve(null);
    });
  });

  it('GET /api/v1/health returns 200 OK', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('request without Bearer token returns 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('Warehouse Staff cannot access owner dashboard', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/dashboard')
      .set('Authorization', `Bearer ${tokenStore2Staff}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('Admin cannot select a store through x-store-id on shop APIs', async () => {
    const res = await request(app)
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .set('x-store-id', '1');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('access token for a locked user is rejected', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 1,
      email: 'owner1@store1.com',
      role: 'SHOP_OWNER',
      storeId: 1,
      isActive: false,
      store: { isActive: true },
    });

    const res = await request(app)
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenStore1Owner}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
