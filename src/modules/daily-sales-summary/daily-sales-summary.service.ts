import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import {
  addBusinessDays,
  businessDateKeyToDate,
  businessDateRangeFromDates,
  canonicalDateToBusinessDateKey,
  toBusinessDateKey,
} from '../../common/utils/business-date';

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
  historicalCostMissingQty?: number;
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
    const { fromKey, toKey, startUtc, endUtc } = businessDateRangeFromDates(fromDate, toDate);
    const summaryStart = businessDateKeyToDate(fromKey);
    const summaryEnd = businessDateKeyToDate(toKey);

    return this.prisma.$transaction(async (tx) => {
      const scopedSummaryWhere = {
        storeId,
        summaryDate: {
          gte: summaryStart,
          lte: summaryEnd,
        },
        ...(stockItemIds && stockItemIds.length > 0 ? { stockItemId: { in: stockItemIds } } : {}),
      };

      await tx.dailySalesSummary.deleteMany({
        where: scopedSummaryWhere,
      });

      // 1. Fetch relevant StockItems
      const stockItems = await tx.stockItem.findMany({
        where: {
          storeId,
          ...(stockItemIds && stockItemIds.length > 0 ? { id: { in: stockItemIds } } : {}),
        },
        select: {
          id: true,
        },
      });

      if (stockItems.length === 0) {
        return { processedCount: 0, updatedDays: 0 };
      }

      const itemIds = stockItems.map((item) => item.id);

      // 2. Fetch fulfilled OrderItems within range
      const orderItems = await tx.orderItem.findMany({
      where: {
        storeId,
        stockItemId: { in: itemIds },
        order: {
          status: 'FULFILLED',
          fulfilledAt: {
            gte: startUtc,
            lt: endUtc,
          },
        },
      },
      select: {
        stockItemId: true,
        quantity: true,
        refundableAmount: true,
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
      const historicalSales = await tx.historicalSale.findMany({
      where: {
        storeId,
        stockItemId: { in: itemIds },
        soldAt: {
          gte: startUtc,
          lt: endUtc,
        },
      },
      select: {
        stockItemId: true,
        quantity: true,
        totalAmount: true,
        costPriceSnapshot: true,
        soldAt: true,
        externalOrderId: true,
      },
    });

      // 4. Fetch ReturnItems within range
      const returnItems = await tx.returnItem.findMany({
        where: {
          storeId,
          stockItemId: { in: itemIds },
          returnOrder: {
            status: 'COMPLETED',
            createdAt: {
              gte: startUtc,
              lt: endUtc,
            },
          },
        },
        select: {
          stockItemId: true,
          quantity: true,
          refundPrice: true,
          isRestockable: true,
          orderItem: {
            select: {
              costPriceSnapshot: true,
            },
          },
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
          grossRevenue: Prisma.Decimal;
          refundAmount: Prisma.Decimal;
          cogs: Prisma.Decimal;
          historicalCostMissingQty: number;
          orderIds: Set<string>;
        }
      >();

      const getKey = (stockItemId: number, date: Date) => {
        const d = toBusinessDateKey(date);
        return `${stockItemId}_${d}`;
      };

      const getOrCreate = (stockItemId: number, date: Date) => {
        const key = getKey(stockItemId, date);
        let entry = map.get(key);
        if (!entry) {
          const dateOnly = businessDateKeyToDate(toBusinessDateKey(date));
          entry = {
            stockItemId,
            summaryDate: dateOnly,
            grossSoldQty: 0,
            returnQty: 0,
            grossRevenue: new Prisma.Decimal(0),
            refundAmount: new Prisma.Decimal(0),
            cogs: new Prisma.Decimal(0),
            historicalCostMissingQty: 0,
            orderIds: new Set(),
          };
          map.set(key, entry);
        }
        return entry;
      };

      // Accumulate OrderItems
      for (const oi of orderItems) {
        const date = oi.order.fulfilledAt || startUtc;
        const entry = getOrCreate(oi.stockItemId, date);
        entry.grossSoldQty += oi.quantity;
        entry.grossRevenue = entry.grossRevenue.plus(new Prisma.Decimal(oi.refundableAmount));
        const itemCost = new Prisma.Decimal(oi.costPriceSnapshot);
        entry.cogs = entry.cogs.plus(itemCost.mul(oi.quantity));
        entry.orderIds.add(`ORD_${oi.order.id}`);
      }

      // Accumulate HistoricalSales
      for (const hs of historicalSales) {
        if (!hs.stockItemId) continue;
        const entry = getOrCreate(hs.stockItemId, hs.soldAt);
        entry.grossSoldQty += hs.quantity;
        entry.grossRevenue = entry.grossRevenue.plus(new Prisma.Decimal(hs.totalAmount));
        if (hs.costPriceSnapshot == null) {
          entry.historicalCostMissingQty += hs.quantity;
        } else {
          entry.cogs = entry.cogs.plus(new Prisma.Decimal(hs.costPriceSnapshot).mul(hs.quantity));
        }
        entry.orderIds.add(`HS_${hs.externalOrderId || hs.soldAt.toISOString()}`);
      }

      // Accumulate ReturnItems
      for (const ri of returnItems) {
        const date = ri.returnOrder.createdAt;
        const entry = getOrCreate(ri.stockItemId, date);
        entry.returnQty += ri.quantity;
        entry.refundAmount = entry.refundAmount.plus(new Prisma.Decimal(ri.refundPrice));

        // Return COGS Accounting Policy:
        // - Restockable return: reverse COGS using original sale-time cost snapshot (orderItem.costPriceSnapshot)
        // - Non-restockable return: do not reverse COGS in this MVP
        // - Return-only days: allow daily COGS to become negative (no clamping to zero)
        if (ri.isRestockable) {
          const unitCost = ri.orderItem
            ? new Prisma.Decimal(ri.orderItem.costPriceSnapshot)
            : new Prisma.Decimal(0);
          const returnCogs = unitCost.mul(ri.quantity);
          entry.cogs = entry.cogs.minus(returnCogs);
        }
      }

      // Upsert into DailySalesSummary
      let processedCount = 0;
      const entries = Array.from(map.values());

      for (const entry of entries) {
        const netSoldQty = entry.grossSoldQty - entry.returnQty;
        const netRevenue = entry.grossRevenue.minus(entry.refundAmount);
        const grossProfit = netRevenue.minus(entry.cogs).toDecimalPlaces(2);

        await tx.dailySalesSummary.upsert({
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
            grossRevenue: entry.grossRevenue,
            refundAmount: entry.refundAmount,
            netRevenue,
            cogs: entry.cogs,
            grossProfit,
            historicalCostMissingQty: entry.historicalCostMissingQty,
            orderCount: entry.orderIds.size,
          },
          create: {
            storeId,
            stockItemId: entry.stockItemId,
            summaryDate: entry.summaryDate,
            grossSoldQty: entry.grossSoldQty,
            returnQty: entry.returnQty,
            netSoldQty,
            grossRevenue: entry.grossRevenue,
            refundAmount: entry.refundAmount,
            netRevenue,
            cogs: entry.cogs,
            grossProfit,
            historicalCostMissingQty: entry.historicalCostMissingQty,
            orderCount: entry.orderIds.size,
          },
        });
        processedCount++;
      }

      return {
        processedCount,
        updatedDays: entries.length,
      };
    });
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
    const todayKey = toBusinessDateKey(today);

    const fromKey = addBusinessDays(todayKey, -(days - 1));
    const fromDate = businessDateKeyToDate(fromKey);
    const todayDate = businessDateKeyToDate(todayKey);

    const summaries = await this.prisma.dailySalesSummary.findMany({
      where: {
        storeId,
        stockItemId,
        summaryDate: {
          gte: fromDate,
          lte: todayDate,
        },
      },
      orderBy: { summaryDate: 'asc' },
    });

    const summaryMap = new Map<string, (typeof summaries)[0]>();
    for (const s of summaries) {
      const dStr = canonicalDateToBusinessDateKey(s.summaryDate);
      summaryMap.set(dStr, s);
    }

    const series: DailySalesSummaryAggregateRow[] = [];
    for (let i = 0; i < days; i++) {
      const curDate = new Date(fromDate);
      curDate.setUTCDate(fromDate.getUTCDate() + i);
      const dStr = canonicalDateToBusinessDateKey(curDate);

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
          historicalCostMissingQty: existing.historicalCostMissingQty,
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
          historicalCostMissingQty: 0,
          orderCount: 0,
        });
      }
    }

    return series;
  }
}
