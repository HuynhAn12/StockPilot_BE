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

    // 3. Aggregate inventory total stock and calculate valuation directly on the database
    let totalStockQuantity = 0;
    let inventoryCostValuation = 0;
    let inventoryRetailValuation = 0;

    try {
      const rows = await (prisma as any).$queryRaw<Array<{ totalQty: any; costVal: any; retailVal: any }>>`
        SELECT
          COALESCE(SUM(ib.quantity), 0) AS totalQty,
          COALESCE(SUM(ib.quantity * si.costPrice), 0) AS costVal,
          COALESCE(SUM(ib.quantity * si.sellingPrice), 0) AS retailVal
        FROM inventory_balances ib
        JOIN stock_items si ON si.id = ib.stockItemId
        WHERE ib.storeId = ${storeId}
      `;

      if (rows && rows.length > 0) {
        totalStockQuantity = Number(rows[0].totalQty) || 0;
        inventoryCostValuation = Number(rows[0].costVal) || 0;
        inventoryRetailValuation = Number(rows[0].retailVal) || 0;
      }
    } catch {
      // Fallback for mocked environments
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

      totalStockQuantity = balances.reduce((sum, b) => sum + b.quantity, 0);
      inventoryCostValuation = balances.reduce((sum, b) => sum + b.quantity * toNumber(b.stockItem.costPrice), 0);
      inventoryRetailValuation = balances.reduce((sum, b) => sum + b.quantity * toNumber(b.stockItem.sellingPrice), 0);
    }

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
