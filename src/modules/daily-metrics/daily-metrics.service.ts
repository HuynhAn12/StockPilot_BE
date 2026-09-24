import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';

export interface DailyMetricAggregateRow {
  metricDate: string; // YYYY-MM-DD
  grossSoldQty: number;
  returnedQty: number;
  netSoldQty: number;
  grossRevenue: number;
  refundAmount: number;
  netRevenue: number;
  orderCount: number;
}

export class DailyMetricsService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /**
   * Rebuild daily SKU metrics for a store in a given date range.
   * Cleans up and recomputes from Orders, HistoricalSales, and Returns.
   */
  async rebuildDailyMetrics(
    storeId: number,
    fromDate: Date,
    toDate: Date,
    stockItemIds?: number[]
  ): Promise<{ processedCount: number; updatedDays: number }> {
    // Normalize date bounds (start of fromDate, end of toDate in UTC/local)
    const start = new Date(fromDate);
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(toDate);
    end.setUTCHours(23, 59, 59, 999);

    // 1. Fetch relevant StockItems
    const stockItems = await this.prisma.stockItem.findMany({
      where: {
        storeId,
        ...(stockItemIds && stockItemIds.length > 0 ? { id: { in: stockItemIds } } : {}),
      },
      select: { id: true },
    });

    if (stockItems.length === 0) {
      return { processedCount: 0, updatedDays: 0 };
    }

    const itemIds = stockItems.map((item) => item.id);

    // 2. Fetch fulfilled OrderItems within range
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        storeId,
        stockItemId: { in: itemIds },
        order: {
          status: 'FULFILLED',
          fulfilledAt: {
            gte: start,
            lte: end,
          },
        },
      },
      select: {
        stockItemId: true,
        quantity: true,
        subtotal: true,
        order: {
          select: {
            id: true,
            fulfilledAt: true,
          },
        },
      },
    });

    // 3. Fetch HistoricalSales within range
    const historicalSales = await this.prisma.historicalSale.findMany({
      where: {
        storeId,
        stockItemId: { in: itemIds },
        soldAt: {
          gte: start,
          lte: end,
        },
      },
      select: {
        stockItemId: true,
        quantity: true,
        totalAmount: true,
        soldAt: true,
        externalOrderId: true,
      },
    });

    // 4. Fetch ReturnItems within range
    const returnItems = await this.prisma.returnItem.findMany({
      where: {
        storeId,
        stockItemId: { in: itemIds },
        returnOrder: {
          status: 'COMPLETED',
          createdAt: {
            gte: start,
            lte: end,
          },
        },
      },
      select: {
        stockItemId: true,
        quantity: true,
        refundPrice: true,
        returnOrder: {
          select: {
            createdAt: true,
          },
        },
      },
    });

    // Accumulator map: Key = `${stockItemId}_${dateString}`
    const map = new Map<
      string,
      {
        stockItemId: number;
        metricDate: Date;
        grossSoldQty: number;
        returnedQty: number;
        grossRevenue: number;
        refundAmount: number;
        orderIds: Set<string>;
      }
    >();

    const getKey = (stockItemId: number, date: Date) => {
      const d = date.toISOString().split('T')[0];
      return `${stockItemId}_${d}`;
    };

    const getOrCreate = (stockItemId: number, date: Date) => {
      const key = getKey(stockItemId, date);
      let entry = map.get(key);
      if (!entry) {
        const dateOnly = new Date(date.toISOString().split('T')[0] + 'T00:00:00.000Z');
        entry = {
          stockItemId,
          metricDate: dateOnly,
          grossSoldQty: 0,
          returnedQty: 0,
          grossRevenue: 0,
          refundAmount: 0,
          orderIds: new Set(),
        };
        map.set(key, entry);
      }
      return entry;
    };

    // Accumulate OrderItems
    for (const oi of orderItems) {
      const date = oi.order.fulfilledAt || start;
      const entry = getOrCreate(oi.stockItemId, date);
      entry.grossSoldQty += oi.quantity;
      entry.grossRevenue += Number(oi.subtotal);
      entry.orderIds.add(`ORD_${oi.order.id}`);
    }

    // Accumulate HistoricalSales
    for (const hs of historicalSales) {
      if (!hs.stockItemId) continue;
      const entry = getOrCreate(hs.stockItemId, hs.soldAt);
      entry.grossSoldQty += hs.quantity;
      entry.grossRevenue += Number(hs.totalAmount);
      entry.orderIds.add(`HS_${hs.externalOrderId || hs.soldAt.toISOString()}`);
    }

    // Accumulate ReturnItems
    for (const ri of returnItems) {
      const date = ri.returnOrder.createdAt;
      const entry = getOrCreate(ri.stockItemId, date);
      entry.returnedQty += ri.quantity;
      const itemRefund = Number(ri.refundPrice) * ri.quantity;
      entry.refundAmount += itemRefund;
    }

    // Upsert into DailySkuMetric
    let processedCount = 0;
    const entries = Array.from(map.values());

    for (const entry of entries) {
      const netSoldQty = Math.max(0, entry.grossSoldQty - entry.returnedQty);
      const netRevenue = Math.max(0, entry.grossRevenue - entry.refundAmount);

      await this.prisma.dailySkuMetric.upsert({
        where: {
          storeId_stockItemId_metricDate: {
            storeId,
            stockItemId: entry.stockItemId,
            metricDate: entry.metricDate,
          },
        },
        update: {
          grossSoldQty: entry.grossSoldQty,
          returnedQty: entry.returnedQty,
          netSoldQty,
          grossRevenue: new Prisma.Decimal(entry.grossRevenue),
          refundAmount: new Prisma.Decimal(entry.refundAmount),
          netRevenue: new Prisma.Decimal(netRevenue),
          orderCount: entry.orderIds.size,
        },
        create: {
          storeId,
          stockItemId: entry.stockItemId,
          metricDate: entry.metricDate,
          grossSoldQty: entry.grossSoldQty,
          returnedQty: entry.returnedQty,
          netSoldQty,
          grossRevenue: new Prisma.Decimal(entry.grossRevenue),
          refundAmount: new Prisma.Decimal(entry.refundAmount),
          netRevenue: new Prisma.Decimal(netRevenue),
          orderCount: entry.orderIds.size,
        },
      });
      processedCount++;
    }

    return {
      processedCount,
      updatedDays: entries.length,
    };
  }

  /**
   * Retrieves an array of daily series metrics for a SKU over the past N days.
   * Every day in the window is guaranteed to be present (missing days have 0 net sales).
   */
  async getDailySeries(
    storeId: number,
    stockItemId: number,
    days: number
  ): Promise<DailyMetricAggregateRow[]> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const fromDate = new Date(today);
    fromDate.setUTCDate(today.getUTCDate() - (days - 1));

    const metrics = await this.prisma.dailySkuMetric.findMany({
      where: {
        storeId,
        stockItemId,
        metricDate: {
          gte: fromDate,
          lte: today,
        },
      },
      orderBy: { metricDate: 'asc' },
    });

    const metricMap = new Map<string, (typeof metrics)[0]>();
    for (const m of metrics) {
      const dStr = m.metricDate.toISOString().split('T')[0];
      metricMap.set(dStr, m);
    }

    const series: DailyMetricAggregateRow[] = [];
    for (let i = 0; i < days; i++) {
      const curDate = new Date(fromDate);
      curDate.setUTCDate(fromDate.getUTCDate() + i);
      const dStr = curDate.toISOString().split('T')[0];

      const existing = metricMap.get(dStr);
      if (existing) {
        series.push({
          metricDate: dStr,
          grossSoldQty: existing.grossSoldQty,
          returnedQty: existing.returnedQty,
          netSoldQty: existing.netSoldQty,
          grossRevenue: Number(existing.grossRevenue),
          refundAmount: Number(existing.refundAmount),
          netRevenue: Number(existing.netRevenue),
          orderCount: existing.orderCount,
        });
      } else {
        series.push({
          metricDate: dStr,
          grossSoldQty: 0,
          returnedQty: 0,
          netSoldQty: 0,
          grossRevenue: 0,
          refundAmount: 0,
          netRevenue: 0,
          orderCount: 0,
        });
      }
    }

    return series;
  }
}
