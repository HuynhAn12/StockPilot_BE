import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    order: { aggregate: jest.fn(), findMany: jest.fn() },
    returnOrder: { aggregate: jest.fn(), findMany: jest.fn() },
    inventoryBalance: { findMany: jest.fn() },
    orderItem: { groupBy: jest.fn() },
    historicalSale: { groupBy: jest.fn() },
  },
}));

describe('AnalyticsService - Dashboard Metrics Calculation', () => {
  let analyticsService: AnalyticsService;

  beforeEach(() => {
    jest.clearAllMocks();
    analyticsService = new AnalyticsService();
  });

  it('phải tính đúng Doanh thu gộp, Khoản hoàn tiền, Doanh thu ròng và Định giá tồn kho theo storeId', async () => {
    // 2 fulfilled orders aggregate: 800,000
    (prisma.order.aggregate as jest.Mock).mockResolvedValue({
      _count: { id: 2 },
      _sum: { totalAmount: 800000 },
    });
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { id: 1, totalAmount: 500000, items: [] },
      { id: 2, totalAmount: 300000, items: [] },
    ]);

    // 1 return aggregate: 100,000
    (prisma.returnOrder.aggregate as jest.Mock).mockResolvedValue({
      _count: { id: 1 },
      _sum: { totalRefundAmount: 100000 },
    });

    // Inventory: 10 items * 50,000 cost = 500,000
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([
      { quantity: 10, stockItem: { costPrice: 50000, sellingPrice: 100000 } },
    ]);

    const result = await analyticsService.getDashboardMetrics(1);

    expect(result.completedOrdersCount).toBe(2);
    expect(result.grossRevenue).toBe(800000);
    expect(result.refundedAmount).toBe(100000);
    expect(result.netRevenue).toBe(700000); // 800,000 - 100,000
    expect(result.totalStockQuantity).toBe(10);
    expect(result.inventoryValuation).toBe(500000);
  });

  it('trả về nhóm hàng thật của cửa hàng (doanh thu cao trước) và tính "ngày không bán" từ lần bán cuối', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const item = (stockItemId: number, category: string, subtotal: number) => ({
      stockItemId, quantity: 1, subtotal, costPriceSnapshot: subtotal / 2, nameSnapshot: `SP${stockItemId}`, skuSnapshot: `SP${stockItemId}`,
      stockItem: { product: { category: { name: category } } },
    });
    (prisma.order.aggregate as jest.Mock).mockResolvedValue({ _count: { id: 1 }, _sum: { totalAmount: 300000 } });
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { id: 1, totalAmount: 300000, items: [item(1, 'Bánh lạnh', 100000), item(2, 'Nguyên liệu', 200000)] },
    ]);
    (prisma.returnOrder.aggregate as jest.Mock).mockResolvedValue({ _count: { id: 0 }, _sum: { totalRefundAmount: 0 } });
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([
      { stockItemId: 1, quantity: 5, stockItem: { id: 1, sku: 'SP1', name: 'SP1', costPrice: 1000, sellingPrice: 2000, createdAt: new Date(Date.now() - 400 * DAY) } },
      // Không bán trong kỳ: lần bán cuối 40 ngày trước, dù mã được tạo 400 ngày trước
      { stockItemId: 3, quantity: 2, stockItem: { id: 3, sku: 'SP3', name: 'SP3', costPrice: 1000, sellingPrice: 2000, createdAt: new Date(Date.now() - 400 * DAY) } },
      // Chưa bán lần nào: tính từ ngày tạo
      { stockItemId: 4, quantity: 3, stockItem: { id: 4, sku: 'SP4', name: 'SP4', costPrice: 1000, sellingPrice: 2000, createdAt: new Date(Date.now() - 10 * DAY) } },
    ]);
    (prisma.orderItem.groupBy as jest.Mock).mockResolvedValue([{ stockItemId: 3, _max: { createdAt: new Date(Date.now() - 60 * DAY) } }]);
    (prisma.historicalSale.groupBy as jest.Mock).mockResolvedValue([{ stockItemId: 3, _max: { soldAt: new Date(Date.now() - 40 * DAY) } }]);

    const result = await analyticsService.getDashboardMetrics(1);

    expect(result.categoryStats.map((c: { name: string }) => c.name)).toEqual(['Nguyên liệu', 'Bánh lạnh']);
    expect(prisma.orderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ storeId: 1, stockItemId: { in: [3, 4] }, order: { status: 'FULFILLED' } }) })
    );
    const slow = Object.fromEntries(result.slowMovers.map((m: { sku: string }) => [m.sku, m]));
    expect(Object.keys(slow)).toEqual(['SP3', 'SP4']);
    expect(slow.SP3).toMatchObject({ daysNoSale: 40, neverSold: false });
    expect(slow.SP4).toMatchObject({ daysNoSale: 10, neverSold: true, lastSoldAt: null });
  });
});
