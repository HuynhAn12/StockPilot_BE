import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    order: { aggregate: jest.fn(), findMany: jest.fn() },
    returnOrder: { findMany: jest.fn() },
    historicalSale: { aggregate: jest.fn(), count: jest.fn() },
    store: { findUnique: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

describe('Tax support API (/api/v1/tax-support)', () => {
  const app = createApp();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ownerA = generateAccessToken({ userId: 1, email: 'owner@a.test', role: 'SHOP_OWNER', storeId: 1 });
  const staffA = generateAccessToken({ userId: 2, email: 'staff@a.test', role: 'WAREHOUSE_STAFF', storeId: 1 });
  const ownerB = generateAccessToken({ userId: 4, email: 'owner@b.test', role: 'SHOP_OWNER', storeId: 2 });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
      const users: Record<number, unknown> = {
        1: { id: 1, email: 'owner@a.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
        2: { id: 2, email: 'staff@a.test', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
        4: { id: 4, email: 'owner@b.test', role: 'SHOP_OWNER', storeId: 2, isActive: true, store: { isActive: true } },
      };
      return Promise.resolve(users[where.id] ?? null);
    });
    (prisma.order.aggregate as jest.Mock).mockResolvedValue({ _min: { fulfilledAt: null } });
    (prisma.historicalSale.aggregate as jest.Mock).mockResolvedValue({ _min: { soldAt: null } });
    (prisma.historicalSale.count as jest.Mock).mockResolvedValue(0);
    (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.returnOrder.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.store.findUnique as jest.Mock).mockResolvedValue({ name: 'Tạp hóa A', address: null });
    (prisma.systemSetting.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
  });

  /** Every raw SQL call must be bound to the caller's store (value right after "WHERE storeId = "). */
  const rawStoreIds = () =>
    (prisma.$queryRaw as jest.Mock).mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => {
      const i = strings.findIndex((s) => /storeId = $/.test(s));
      return values[i];
    });

  it('returns the threshold snapshot for the owner, scoped to the token’s store', async () => {
    const res = await request(app).get('/api/v1/tax-support/revenue-threshold').set(auth(ownerB));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ threshold: 1_000_000_000, ytdRevenue: 0, level: 'NONE' });
    expect(res.body.data.notes[0]).toContain('Chỉ tính doanh thu ghi nhận trên StockPilot');
    // Năm nay + năm trước, mỗi lần 3 truy vấn (đơn, hàng trả, lịch sử nhập).
    expect(rawStoreIds()).toHaveLength(6);
    expect(rawStoreIds().every((id) => id === 2)).toBe(true);
    expect((prisma.order.aggregate as jest.Mock).mock.calls.every(([arg]) => arg.where.storeId === 2)).toBe(true);
  });

  it('uses the admin-configured threshold', async () => {
    (prisma.systemSetting.findUnique as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.key === 'tax.eInvoiceRevenueThreshold' ? { key: where.key, valueJson: 500_000_000 } : null)
    );
    const res = await request(app).get('/api/v1/tax-support/revenue-threshold').set(auth(ownerA));
    expect(res.body.data.threshold).toBe(500_000_000);
  });

  it.each([
    ['/api/v1/tax-support/revenue-threshold'],
    ['/api/v1/tax-support/revenue-book?template=S1A&period=year&year=2025'],
    ['/api/v1/tax-support/revenue-book/preview?template=S1A&period=year&year=2025'],
  ])('forbids warehouse staff: %s', async (url) => {
    const res = await request(app).get(url).set(auth(staffA));
    expect(res.status).toBe(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/tax-support/revenue-threshold');
    expect(res.status).toBe(401);
  });

  it.each([
    ['template=S3A&period=year&year=2025', 'template'],
    ['template=S1A&period=quarter&year=2025', 'quarter'],
    ['template=S1A&period=month&year=2025&month=13', 'month'],
    ['template=S1A&period=year&year=1999', 'year'],
  ])('rejects invalid query %s', async (query, field) => {
    const res = await request(app).get(`/api/v1/tax-support/revenue-book?${query}`).set(auth(ownerA));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error)).toContain(field);
  });

  it('rejects a period that has not started yet', async () => {
    const res = await request(app).get('/api/v1/tax-support/revenue-book?template=S1A&period=year&year=2099').set(auth(ownerA));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('chưa bắt đầu');
  });

  it('downloads the S1a book as a CSV attachment', async () => {
    const res = await request(app).get('/api/v1/tax-support/revenue-book?template=S1A&period=year&year=2025').set(auth(ownerA));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="so-doanh-thu-S1a-2025.csv"');
    expect(res.text).toContain('Mẫu số S1a-HKD');
    expect(res.text).toContain('Không phát sinh doanh thu trong kỳ');
    expect((prisma.store.findUnique as jest.Mock).mock.calls[0][0].where).toEqual({ id: 1 });
  });

  it('previews totals without building the file', async () => {
    const res = await request(app).get('/api/v1/tax-support/revenue-book/preview?template=S2A&period=quarter&year=2025&quarter=4').set(auth(ownerA));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ template: 'S2A', total: 0, lineCount: 0, partialUntil: null });
    expect(res.body.data.periodLabel).toBe('Quý 4/2025 (01/10/2025 – 31/12/2025)');
  });
});
