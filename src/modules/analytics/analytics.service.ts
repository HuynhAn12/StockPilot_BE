import { prisma } from '../../config/db';
import { toNumber } from '../../common/utils/decimal';

export class AnalyticsService {
  async getDashboardMetrics(storeId: number) {
    const fulfilledOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: 'FULFILLED',
      },
      select: {
        totalAmount: true,
      },
    });

    const completedOrdersCount = fulfilledOrders.length;
    const grossRevenue = fulfilledOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);

    const returns = await prisma.returnOrder.findMany({
      where: {
        storeId,
        status: 'COMPLETED',
      },
      select: {
        totalRefundAmount: true,
      },
    });

    const refundedAmount = returns.reduce((sum, r) => sum + toNumber(r.totalRefundAmount), 0);
    const netRevenue = Math.max(0, grossRevenue - refundedAmount);

    const balances = await prisma.inventoryBalance.findMany({
      where: { storeId },
      include: {
        stockItem: true,
      },
    });

    const totalStockQuantity = balances.reduce((sum, b) => sum + b.quantity, 0);
    const inventoryValuation = balances.reduce((sum, b) => sum + b.quantity * toNumber(b.stockItem.costPrice), 0);

    return {
      storeId,
      completedOrdersCount,
      grossRevenue,
      refundedAmount,
      netRevenue,
      totalStockQuantity,
      inventoryValuation,
    };
  }
}
