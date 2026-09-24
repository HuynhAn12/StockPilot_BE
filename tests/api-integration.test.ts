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

  it('HTTP POST /api/v1/historical-sales/preview & /commit carries costPrice without double-parse loss', async () => {
    (prisma as any).stockItem = {
      findMany: jest.fn().mockResolvedValue([{ id: 10, sku: 'SKU-A', name: 'Product A' }]),
    };
    (prisma as any).order = {
      findFirst: jest.fn().mockResolvedValue(null),
    };
    (prisma as any).historicalSale = {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    let createdJobItems: any[] = [];
    const validJobId = '123e4567-e89b-12d3-a456-426614174000';
    (prisma as any).importJob = {
      create: jest.fn().mockImplementation(async (args) => {
        createdJobItems = args.data.items.create;
        return { id: validJobId, totalRows: args.data.totalRows };
      }),
      findUnique: jest.fn().mockImplementation(async () => ({
        id: validJobId,
        storeId: 1,
        status: 'PREVIEWED',
        expiresAt: new Date(Date.now() + 100000),
        items: createdJobItems.map((item, idx) => ({
          rowNumber: idx + 1,
          stockItemId: item.stockItemId,
          sku: item.sku,
          status: item.status,
          resultJson: item.resultJson,
        })),
      })),
      update: jest.fn().mockResolvedValue({ id: validJobId, status: 'COMPLETED' }),
    };
    (prisma as any).importJobItem = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    (prisma as any).idempotencyRequest = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idem-1' }),
      update: jest.fn().mockResolvedValue({ id: 'idem-1' }),
    };
    (prisma as any).$transaction = jest.fn((cb) => cb(prisma));

    // 1. Send HTTP POST to preview endpoint through real Express router and middleware
    const previewRes = await request(app)
      .post('/api/v1/historical-sales/preview')
      .set('Authorization', `Bearer ${tokenStore1Owner}`)
      .send({
        rows: [
          {
            sku: 'SKU-A',
            quantity: 2,
            unitPrice: 100000,
            costPrice: 60000,
            soldAt: '2026-05-01T10:00:00.000Z',
            source: 'CSV',
          },
        ],
      });

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.success).toBe(true);
    expect(previewRes.body.data.previewSample[0].costPriceSnapshot).toBe(60000);
    expect(createdJobItems[0].resultJson.costPriceSnapshot).toBe(60000);

    // 2. Commit the job via HTTP POST
    const commitRes = await request(app)
      .post('/api/v1/historical-sales/commit')
      .set('Authorization', `Bearer ${tokenStore1Owner}`)
      .set('Idempotency-Key', '88888888-4444-4444-4444-121212121212')
      .send({ jobId: validJobId });

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.success).toBe(true);
    const createManyCall = (prisma as any).historicalSale.createMany.mock.calls[0][0];
    expect(Number(createManyCall.data[0].costPriceSnapshot)).toBe(60000);
    expect(createManyCall.data[0].externalSku).toBe('SKU-A');
  });
});
