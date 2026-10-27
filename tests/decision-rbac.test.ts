import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    stockItem: { findFirst: jest.fn(), findMany: jest.fn() },
    dailySalesSummary: { findMany: jest.fn() },
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    historicalSale: { findFirst: jest.fn() },
    engineConfig: { findUnique: jest.fn() },
    alert: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
    pricingRecommendation: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    priceHistory: { findMany: jest.fn() },
    decisionSnapshot: { findFirst: jest.fn(), findMany: jest.fn() },
    stockMovement: { findFirst: jest.fn(), groupBy: jest.fn() },
    inventoryBalance: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
    auditLog: { create: jest.fn() },
    aiInteraction: { create: jest.fn(), count: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

/**
 * D9 / PRI-003 regression suite: staff must never receive cost, floor price, margin, capital, or
 * pricing recommendation data from Decision Engine, Alerts, Pricing, or Assistant endpoints, and
 * every SKU lookup must be scoped by the caller's store.
 */

const FORBIDDEN_STAFF_KEYS = [
  'costPrice',
  'minimumPrice',
  'minimumMarginPct',
  'maxMarkdownPct',
  'maxMarkupPct',
  'expectedMarginPct',
  'deadStockCostValue',
  'totalDeadStockCostValue',
  'pricingEvaluation',
  'pricingRecommendation',
  'lossPerUnit',
  'curMargin',
  'totalEstimateCost',
  'totalTiedCapital',
];

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

function expectNoFinancialData(body: unknown) {
  const keys = collectKeys(body);
  for (const forbidden of FORBIDDEN_STAFF_KEYS) {
    expect({ key: forbidden, present: keys.has(forbidden) }).toEqual({ key: forbidden, present: false });
  }
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/Giá vốn|Biên lợi nhuận|Vốn đọng|ngân sách/i);
}

const STORE_A_SKU = {
  id: 10,
  storeId: 1,
  sku: 'SKU-10',
  name: 'Sữa tươi',
  costPrice: 80000,
  sellingPrice: 70000, // selling at a loss: the owner factor label would quote the cost price
  minStockLevel: 5,
  maxStockLevel: 50,
  isActive: true,
  product: { category: { name: 'Đồ uống' } },
  balances: [{ quantity: 30, reservedQuantity: 0 }],
};

describe('Decision Engine role projection and store isolation (D9)', () => {
  const app = createApp();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const ownerToken = generateAccessToken({ userId: 1, email: 'owner@a.test', role: 'SHOP_OWNER', storeId: 1 });
  const staffToken = generateAccessToken({ userId: 2, email: 'staff@a.test', role: 'WAREHOUSE_STAFF', storeId: 1 });
  const ownerStoreBToken = generateAccessToken({ userId: 4, email: 'owner@b.test', role: 'SHOP_OWNER', storeId: 2 });

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

    // Store-scoped lookup: only answers when the query itself carries the owning storeId.
    (prisma.stockItem.findFirst as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where?.id === 10 && where?.storeId === 1 ? STORE_A_SKU : null)
    );
    (prisma.stockItem.findMany as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where?.storeId === 1 ? [{ id: 10, sku: 'SKU-10', name: 'Sữa tươi' }] : [])
    );
    (prisma.dailySalesSummary.findMany as jest.Mock).mockResolvedValue([]);
    // No snapshot yet: read endpoints fall back to a read-only live evaluation.
    (prisma.decisionSnapshot.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.decisionSnapshot.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.stockMovement.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.stockMovement.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);
    // Last sale 200 days ago => dead stock with a cost value for the owner view.
    (prisma.historicalSale.findFirst as jest.Mock).mockResolvedValue({
      soldAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
    (prisma.engineConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.alert.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.alert.count as jest.Mock).mockResolvedValue(0);
    (prisma.pricingRecommendation.findFirst as jest.Mock).mockResolvedValue({
      currentPrice: 70000,
      recommendedPrice: 100000,
      discountPct: 0,
      action: 'INCREASE',
      reasonJson: {},
    });
    (prisma.pricingRecommendation.count as jest.Mock).mockResolvedValue(3);
    (prisma.aiInteraction.create as jest.Mock).mockResolvedValue({ id: 1, createdAt: new Date() });
    (prisma.aiInteraction.count as jest.Mock).mockResolvedValue(0);
    (prisma.systemSetting.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([
      {
        quantity: 0,
        stockItem: { id: 10, sku: 'SKU-10', name: 'Sữa tươi', minStockLevel: 5, maxStockLevel: 50, costPrice: 80000, sellingPrice: 70000 },
      },
    ]);
  });

  describe('GET /decision-engine', () => {
    it('gives the owner full financial analysis', async () => {
      const res = await request(app).get('/api/v1/decision-engine/sku/10').set(auth(ownerToken));

      expect(res.status).toBe(200);
      expect(res.body.data.pricing.costPrice).toBe(80000);
      expect(res.body.data.pricing.minimumPrice).toBeGreaterThan(80000);
      expect(res.body.data.risk.deadStockCostValue).toBe(30 * 80000);
      expect(res.body.data.pricingEvaluation.action).toBe('INCREASE');
    });

    it('gives staff the operational analysis with no cost, floor, margin, or pricing factors', async () => {
      const res = await request(app).get('/api/v1/decision-engine/sku/10').set(auth(staffToken));

      expect(res.status).toBe(200);
      expect(res.body.data.inventory.available).toBe(30);
      expect(res.body.data.risk.deadStock).toBe(true);
      expect(res.body.data.coverage.reorderPoint).toBeGreaterThanOrEqual(5);
      expect(res.body.data.pricing).toEqual({ sellingPrice: 70000 });
      expect(res.body.data.factors).toEqual([]);
      expectNoFinancialData(res.body);
    });

    it('returns 404 for another store SKU and always queries by id and storeId', async () => {
      const res = await request(app).get('/api/v1/decision-engine/sku/10').set(auth(ownerStoreBToken));

      expect(res.status).toBe(404);
      expect(prisma.stockItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 10, storeId: 2 } })
      );
    });

    it('hides capital totals from the staff overview summary', async () => {
      const staff = await request(app).get('/api/v1/decision-engine/overview').set(auth(staffToken));
      const owner = await request(app).get('/api/v1/decision-engine/overview').set(auth(ownerToken));

      expect(staff.status).toBe(200);
      expect(staff.body.summary.deadStockCount).toBe(1);
      expectNoFinancialData(staff.body);
      expect(owner.body.summary.totalDeadStockCostValue).toBe(30 * 80000);
    });

    it('hides margin and markdown policy from the staff engine config', async () => {
      const res = await request(app).get('/api/v1/decision-engine/config').set(auth(staffToken));

      expect(res.status).toBe(200);
      expect(res.body.data.leadTimeDays).toBe(7);
      expectNoFinancialData(res.body);
    });

    it('allows only owners to trigger a store-wide recalculation', async () => {
      const res = await request(app).post('/api/v1/decision-engine/recalculate').set(auth(staffToken));
      expect(res.status).toBe(403);
    });
  });

  describe('Pricing', () => {
    it('keeps recommendations and price history owner-only', async () => {
      (prisma.priceHistory.findMany as jest.Mock).mockResolvedValue([]);

      await expect(request(app).get('/api/v1/pricing').set(auth(staffToken))).resolves.toMatchObject({ status: 403 });
      await expect(request(app).get('/api/v1/pricing/history').set(auth(staffToken))).resolves.toMatchObject({ status: 403 });
      await expect(request(app).get('/api/v1/pricing/history').set(auth(ownerToken))).resolves.toMatchObject({ status: 200 });
    });
  });

  describe('Alerts (staff acknowledge and report, owner resolves)', () => {
    const openAlert = { id: 5, storeId: 1, stockItemId: 10, type: 'STOCKOUT', status: 'OPEN', title: 'Hết hàng: SKU-10', reasonJson: { availableStock: 0 } };

    it('lets staff acknowledge with a note, notifies owners, and keeps the engine reason payload', async () => {
      (prisma.alert.findFirst as jest.Mock).mockResolvedValue(openAlert);
      (prisma.alert.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ ...openAlert, ...data }));
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 1 }]);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ fullName: 'Nhân viên A', email: 'staff@a.test' });

      const res = await request(app)
        .post('/api/v1/alerts/5/acknowledge')
        .set(auth(staffToken))
        .send({ note: 'Đã gọi nhà cung cấp, thứ 5 có hàng' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACKNOWLEDGED');
      expect(prisma.alert.findFirst).toHaveBeenCalledWith({ where: { id: 5, storeId: 1 } });
      expect(res.body.data.reasonJson).toMatchObject({
        availableStock: 0,
        lifecycle: { acknowledgedById: 2, acknowledgementNote: 'Đã gọi nhà cung cấp, thứ 5 có hàng' },
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { storeId: 1, role: 'SHOP_OWNER', isActive: true } })
      );
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            storeId: 1,
            userId: 1,
            entityType: 'ALERT',
            entityId: '5',
            message: 'Hết hàng: SKU-10. Ghi chú: Đã gọi nhà cung cấp, thứ 5 có hàng',
          }),
        ],
      });
    });

    it('does not notify owners when the owner acknowledges', async () => {
      (prisma.alert.findFirst as jest.Mock).mockResolvedValue(openAlert);
      (prisma.alert.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ ...openAlert, ...data }));

      const res = await request(app).post('/api/v1/alerts/5/acknowledge').set(auth(ownerToken)).send({});

      expect(res.status).toBe(200);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('rejects acknowledging a resolved alert and treats a repeated acknowledge as a no-op', async () => {
      (prisma.alert.findFirst as jest.Mock).mockResolvedValueOnce({ ...openAlert, status: 'RESOLVED' });
      const resolved = await request(app).post('/api/v1/alerts/5/acknowledge').set(auth(staffToken)).send({});
      expect(resolved.status).toBe(409);

      (prisma.alert.findFirst as jest.Mock).mockResolvedValueOnce({ ...openAlert, status: 'ACKNOWLEDGED' });
      const repeated = await request(app).post('/api/v1/alerts/5/acknowledge').set(auth(staffToken)).send({});
      expect(repeated.status).toBe(200);
      expect(prisma.alert.update).not.toHaveBeenCalled();
    });

    it('allows only owners to resolve, records a user resolution, and is idempotent', async () => {
      const staffRes = await request(app).post('/api/v1/alerts/5/resolve').set(auth(staffToken));
      expect(staffRes.status).toBe(403);

      (prisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(openAlert);
      (prisma.alert.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ ...openAlert, ...data }));
      const ownerRes = await request(app).post('/api/v1/alerts/5/resolve').set(auth(ownerToken));
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.data.reasonJson.lifecycle).toMatchObject({ resolvedBy: 'USER', resolvedById: 1 });

      (prisma.alert.findFirst as jest.Mock).mockResolvedValueOnce({ ...openAlert, status: 'RESOLVED' });
      const again = await request(app).post('/api/v1/alerts/5/resolve').set(auth(ownerToken));
      expect(again.status).toBe(200);
      expect(prisma.alert.update).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when resolving an alert of another store', async () => {
      (prisma.alert.findFirst as jest.Mock).mockResolvedValue(null);
      const res = await request(app).post('/api/v1/alerts/5/resolve').set(auth(ownerStoreBToken));

      expect(res.status).toBe(404);
      expect(prisma.alert.findFirst).toHaveBeenCalledWith({ where: { id: 5, storeId: 2 } });
    });

    it('does not read cost price for the staff alert list', async () => {
      await request(app).get('/api/v1/alerts').set(auth(staffToken));

      expect(prisma.alert.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { stockItem: { select: expect.objectContaining({ costPrice: false }) } },
        })
      );
    });
  });

  describe('Assistant (template mode)', () => {
    it('explains a SKU to staff without financial content and without writing to the database', async () => {
      const res = await request(app).get('/api/v1/assistant/sku/10').set(auth(staffToken));

      expect(res.status).toBe(200);
      expect(res.body.data.explanation).toContain('Sữa tươi');
      expectNoFinancialData(res.body);
      expect(prisma.alert.update).not.toHaveBeenCalled();
      expect(prisma.pricingRecommendation.findFirst).not.toHaveBeenCalled();
    });

    it('keeps the owner explanation complete', async () => {
      const res = await request(app).get('/api/v1/assistant/sku/10').set(auth(ownerToken));

      expect(res.status).toBe(200);
      expect(res.body.data.explanation).toContain('Giá vốn');
      expect(res.body.data.explanation).toContain('ĐỀ XUẤT ĐIỀU CHỈNH GIÁ');
    });

    it.each([
      ['sản phẩm nào sắp hết hàng', 'CẦN NHẬP KHO GẤP'],
      ['nên nhập thêm gì', 'KẾ HOẠCH ĐỀ XUẤT NHẬP HÀNG'],
      ['hôm nay có rủi ro gì', 'RỦI RO'],
    ])('answers operational staff question "%s" without financial content', async (question, heading) => {
      const res = await request(app).post('/api/v1/assistant/chat').set(auth(staffToken)).send({ question });

      expect(res.status).toBe(200);
      expect(res.body.data.answer).toContain(heading);
      expectNoFinancialData(res.body);
    });

    it.each(['hàng nào đang bán lỗ', 'có đề xuất giá nào không', 'doanh số tuần này'])(
      'refuses financial staff question "%s"',
      async (question) => {
        const res = await request(app).post('/api/v1/assistant/chat').set(auth(staffToken)).send({ question });

        expect(res.status).toBe(200);
        expect(res.body.data.answer).toContain('chỉ được phép tra cứu số lượng tồn kho');
        expectNoFinancialData(res.body);
      }
    );

    it('validates the chat body', async () => {
      const res = await request(app).post('/api/v1/assistant/chat').set(auth(ownerToken)).send({ question: 123456 });
      expect(res.status).toBe(400);
    });
  });
});
