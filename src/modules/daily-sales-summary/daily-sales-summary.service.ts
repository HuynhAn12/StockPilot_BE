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

export function isTransientConflictError(error: unknown): boolean {
  if (!error) return false;
  const err = error as any;
  if (err.code === 'P2034') return true;
  if (typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('write conflict') ||
      msg.includes('deadlock') ||
      msg.includes('lock wait timeout') ||
      msg.includes('restart transaction')
    ) {
      return true;
    }
  }
  return false;
}

export class DailySalesSummaryService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /**
   * Rebuilds DailySalesSummary facts for a store across a date range.
   * Materializes facts from FULFILLED Orders, HistoricalSales, and COMPLETED Returns.
   * Includes exponential backoff retry for transient MySQL deadlocks/write conflicts.
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

    const scopedSummaryWhere = {
      storeId,
      summaryDate: {
        gte: summaryStart,
        lte: summaryEnd,
      },
      ...(stockItemIds && stockItemIds.length > 0 ? { stockItemId: { in: stockItemIds } } : {}),
    };

    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
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

      // Deterministic lock ordering: sort by stockItemId asc, then summaryDate asc
      entries.sort((a, b) => {
        if (a.stockItemId !== b.stockItemId) {
          return a.stockItemId - b.stockItemId;
        }
        return a.summaryDate.getTime() - b.summaryDate.getTime();
      });

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
      } catch (error) {
        if (isTransientConflictError(error) && attempt < MAX_RETRIES) {
          const jitter = Math.floor(Math.random() * 40);
          const delayMs = 50 * Math.pow(2, attempt - 1) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }
    throw new Error('rebuildDailySalesSummary failed after retries');
  }

  /**
   * Retrieves an array of daily series summaries for a SKU over the past N days.
   * Every day in the window is guaranteed to be present with 0 values if no sales occurred.
   * The window ends at `endDateKey` (inclusive), defaulting to today's business date.
   */
  async getDailySeries(
    storeId: number,
    stockItemId: number,
    days: number,
    db: Pick<Prisma.TransactionClient, 'dailySalesSummary'> = this.prisma,
    endDateKey?: string
  ): Promise<DailySalesSummaryAggregateRow[]> {
    const todayKey = endDateKey ?? toBusinessDateKey(new Date());

    const fromKey = addBusinessDays(todayKey, -(days - 1));
    const fromDate = businessDateKeyToDate(fromKey);
    const todayDate = businessDateKeyToDate(todayKey);

    const summaries = await db.dailySalesSummary.findMany({
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
