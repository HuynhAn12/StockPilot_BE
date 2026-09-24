import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';

export interface DailySalesSummaryAggregateRow {
  summaryDate: string; // YYYY-MM-DD
  grossSoldQty: number;
  returnQty: number;
  netSoldQty: number;
  grossRevenue: number;
  refundAmount: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  orderCount: number;
}

export class DailySalesSummaryService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /**
   * Rebuilds DailySalesSummary records for a store in a given date range.
   * Materializes facts from FULFILLED Orders, HistoricalSales, and COMPLETED Returns.
   */
  async rebuildDailySalesSummary(
    storeId: number,
    fromDate: Date,
    toDate: Date,
    stockItemIds?: number[]
  ): Promise<{ processedCount: number; updatedDays: number }> {
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
      select: {
        id: true,
        costPrice: true,
      },
    });

    if (stockItems.length === 0) {
      return { processedCount: 0, updatedDays: 0 };
    }

    const itemIds = stockItems.map((item) => item.id);
    const itemCostMap = new Map<number, number>();
    for (const item of stockItems) {
      itemCostMap.set(item.id, Number(item.costPrice));
    }

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
        costPriceSnapshot: true,
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
        summaryDate: Date;
        grossSoldQty: number;
        returnQty: number;
        grossRevenue: number;
        refundAmount: number;
        cogs: number;
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
          summaryDate: dateOnly,
          grossSoldQty: 0,
          returnQty: 0,
          grossRevenue: 0,
          refundAmount: 0,
          cogs: 0,
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
      const itemCost = Number(oi.costPriceSnapshot) > 0 ? Number(oi.costPriceSnapshot) : (itemCostMap.get(oi.stockItemId) ?? 0);
      entry.cogs += oi.quantity * itemCost;
      entry.orderIds.add(`ORD_${oi.order.id}`);
    }

    // Accumulate HistoricalSales
    for (const hs of historicalSales) {
      if (!hs.stockItemId) continue;
      const entry = getOrCreate(hs.stockItemId, hs.soldAt);
      entry.grossSoldQty += hs.quantity;
      entry.grossRevenue += Number(hs.totalAmount);
      const fallbackCost = itemCostMap.get(hs.stockItemId) ?? 0;
      entry.cogs += hs.quantity * fallbackCost;
      entry.orderIds.add(`HS_${hs.externalOrderId || hs.soldAt.toISOString()}`);
    }

    // Accumulate ReturnItems
    for (const ri of returnItems) {
      const date = ri.returnOrder.createdAt;
      const entry = getOrCreate(ri.stockItemId, date);
      entry.returnQty += ri.quantity;
      const itemRefund = Number(ri.refundPrice) * ri.quantity;
      entry.refundAmount += itemRefund;
      const itemCost = itemCostMap.get(ri.stockItemId) ?? 0;
      entry.cogs = Math.max(0, entry.cogs - ri.quantity * itemCost);
    }

    // Upsert into DailySalesSummary
    let processedCount = 0;
    const entries = Array.from(map.values());

    for (const entry of entries) {
      const netSoldQty = Math.max(0, entry.grossSoldQty - entry.returnQty);
      const netRevenue = Math.max(0, entry.grossRevenue - entry.refundAmount);
      const grossProfit = Number((netRevenue - entry.cogs).toFixed(2));

      await this.prisma.dailySalesSummary.upsert({
        where: {
          storeId_stockItemId_summaryDate: {
            storeId,
            stockItemId: entry.stockItemId,
            summaryDate: entry.summaryDate,
          },
        },
        update: {
          grossSoldQty: entry.grossSoldQty,
          returnQty: entry.returnQty,
          netSoldQty,
          grossRevenue: new Prisma.Decimal(entry.grossRevenue),
          refundAmount: new Prisma.Decimal(entry.refundAmount),
          netRevenue: new Prisma.Decimal(netRevenue),
          cogs: new Prisma.Decimal(entry.cogs),
          grossProfit: new Prisma.Decimal(grossProfit),
          orderCount: entry.orderIds.size,
        },
        create: {
          storeId,
          stockItemId: entry.stockItemId,
          summaryDate: entry.summaryDate,
          grossSoldQty: entry.grossSoldQty,
          returnQty: entry.returnQty,
          netSoldQty,
          grossRevenue: new Prisma.Decimal(entry.grossRevenue),
          refundAmount: new Prisma.Decimal(entry.refundAmount),
          netRevenue: new Prisma.Decimal(netRevenue),
          cogs: new Prisma.Decimal(entry.cogs),
          grossProfit: new Prisma.Decimal(grossProfit),
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
   * Retrieves an array of daily series summaries for a SKU over the past N days.
   * Every day in the window is guaranteed to be present with 0 values if no sales occurred.
   */
  async getDailySeries(
    storeId: number,
    stockItemId: number,
    days: number
  ): Promise<DailySalesSummaryAggregateRow[]> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const fromDate = new Date(today);
    fromDate.setUTCDate(today.getUTCDate() - (days - 1));

    const summaries = await this.prisma.dailySalesSummary.findMany({
      where: {
        storeId,
        stockItemId,
        summaryDate: {
          gte: fromDate,
          lte: today,
        },
      },
      orderBy: { summaryDate: 'asc' },
    });

    const summaryMap = new Map<string, (typeof summaries)[0]>();
    for (const s of summaries) {
      const dStr = s.summaryDate.toISOString().split('T')[0];
      summaryMap.set(dStr, s);
    }

    const series: DailySalesSummaryAggregateRow[] = [];
    for (let i = 0; i < days; i++) {
      const curDate = new Date(fromDate);
      curDate.setUTCDate(fromDate.getUTCDate() + i);
      const dStr = curDate.toISOString().split('T')[0];

      const existing = summaryMap.get(dStr);
      if (existing) {
        series.push({
          summaryDate: dStr,
          grossSoldQty: existing.grossSoldQty,
          returnQty: existing.returnQty,
          netSoldQty: existing.netSoldQty,
          grossRevenue: Number(existing.grossRevenue),
          refundAmount: Number(existing.refundAmount),
          netRevenue: Number(existing.netRevenue),
          cogs: Number(existing.cogs),
          grossProfit: Number(existing.grossProfit),
          orderCount: existing.orderCount,
        });
      } else {
        series.push({
          summaryDate: dStr,
          grossSoldQty: 0,
          returnQty: 0,
          netSoldQty: 0,
          grossRevenue: 0,
          refundAmount: 0,
          netRevenue: 0,
          cogs: 0,
          grossProfit: 0,
          orderCount: 0,
        });
      }
    }

    return series;
  }
}
