import { prisma } from '../../config/db';
import { toNumber } from '../../common/utils/decimal';

export class AnalyticsService {
  async getDashboardMetrics(storeId: number) {
    // 1. Aggregate fulfilled orders metrics at the database level
    const orderAgg = await prisma.order.aggregate({
      where: {
        storeId,
        status: 'FULFILLED',
      },
      _sum: {
        totalAmount: true,
      },
      _count: {
        id: true,
      },
    });

    const completedOrdersCount = orderAgg._count.id || 0;
    const grossRevenue = toNumber(orderAgg._sum.totalAmount || 0);

    // 2. Aggregate completed return orders metrics at the database level
    const returnAgg = await prisma.returnOrder.aggregate({
      where: {
        storeId,
        status: 'COMPLETED',
      },
      _sum: {
        totalRefundAmount: true,
      },
      _count: {
        id: true,
      },
    });

    const refundedAmount = toNumber(returnAgg._sum.totalRefundAmount || 0);
    const netRevenue = grossRevenue - refundedAmount;

    // 3. Aggregate inventory total stock and calculate valuation
    const balances = await prisma.inventoryBalance.findMany({
      where: { storeId },
      include: {
        stockItem: {
          select: {
            costPrice: true,
            sellingPrice: true,
          },
        },
      },
    });

    const totalStockQuantity = balances.reduce((sum, b) => sum + b.quantity, 0);
    const inventoryCostValuation = balances.reduce((sum, b) => sum + b.quantity * toNumber(b.stockItem.costPrice), 0);
    const inventoryRetailValuation = balances.reduce((sum, b) => sum + b.quantity * toNumber(b.stockItem.sellingPrice), 0);

    return {
      storeId,
      completedOrdersCount,
      grossRevenue,
      refundedAmount,
      netRevenue,
      totalStockQuantity,
      inventoryValuation: inventoryCostValuation,
      inventoryRetailValuation,
    };
  }
}
