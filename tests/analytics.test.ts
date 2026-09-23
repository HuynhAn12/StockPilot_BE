import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    order: { findMany: jest.fn() },
    returnOrder: { findMany: jest.fn() },
    inventoryBalance: { findMany: jest.fn() },
  },
}));

describe('AnalyticsService - Dashboard Metrics Calculation', () => {
  let analyticsService: AnalyticsService;

  beforeEach(() => {
    jest.clearAllMocks();
    analyticsService = new AnalyticsService();
  });

  it('phải tính đúng Doanh thu gộp, Khoản hoàn tiền, Doanh thu ròng và Định giá tồn kho theo storeId', async () => {
    // 2 fulfilled orders: 500,000 + 300,000 = 800,000
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { totalAmount: 500000 },
      { totalAmount: 300000 },
    ]);

    // 1 return: 100,000
    (prisma.returnOrder.findMany as jest.Mock).mockResolvedValue([
      { totalRefundAmount: 100000 },
    ]);

    // Inventory: 10 items * 50,000 cost = 500,000
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([
      { quantity: 10, stockItem: { costPrice: 50000 } },
    ]);

    const result = await analyticsService.getDashboardMetrics(1);

    expect(result.completedOrdersCount).toBe(2);
    expect(result.grossRevenue).toBe(800000);
    expect(result.refundedAmount).toBe(100000);
    expect(result.netRevenue).toBe(700000); // 800,000 - 100,000
    expect(result.totalStockQuantity).toBe(10);
    expect(result.inventoryValuation).toBe(500000);
  });
});
