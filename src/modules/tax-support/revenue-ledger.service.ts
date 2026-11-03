import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import {
  businessDateKeyToDate,
  businessDateRangeToUtc,
  toBusinessDateKey,
} from '../../common/utils/business-date';

/**
 * One business day (Asia/Ho_Chi_Minh) of store revenue. Amounts are VND.
 * net = sales + imported − returns.
 */
export interface LedgerDay {
  day: string; // YYYY-MM-DD, business date
  sales: number;
  imported: number;
  returns: number;
  net: number;
  orderCount: number;
  firstOrderNo: string | null;
  lastOrderNo: string | null;
}

export interface RevenueLedger {
  fromKey: string;
  toKey: string;
  days: LedgerDay[]; // only days with any activity, ascending
  /** First FULFILLED order in StockPilot; imported history from this moment on is ignored. */
  cutover: Date | null;
  /** Imported history rows skipped because they overlap the period already sold in StockPilot. */
  excludedImportedRows: number;
}

export interface LedgerOrderLine {
  day: string;
  reference: string;
  kind: 'SALE' | 'RETURN';
  amount: number;
}

/** Decimal / bigint / string from MySQL → integer number of cents, so sums stay exact. */
export const toCents = (value: unknown): number => Math.round(Number(value ?? 0) * 100);
const fromCents = (cents: number): number => cents / 100;

/**
 * Single source of revenue for the e-invoice threshold tracker and the S1a/S2a revenue book.
 * Same rules as the dashboard: FULFILLED orders by fulfilledAt, COMPLETED returns by createdAt, plus
 * imported sales history (all rows, matched to a SKU or not — daily_sales_summary skips unmatched rows)
 * dated before the store's first StockPilot sale, so history and live sales are never counted twice.
 * Aggregation runs in MySQL (GROUP BY business day); at most one row per day comes back to Node.
 */
export class RevenueLedgerService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /** Minutes to add to a UTC timestamp to get the business-time wall clock (VN: +420, no DST). */
  private offsetMinutes(dateKey: string): number {
    return Math.round((businessDateKeyToDate(dateKey).getTime() - businessDateRangeToUtc(dateKey).startUtc.getTime()) / 60000);
  }

  async cutover(storeId: number): Promise<Date | null> {
    const agg = await this.prisma.order.aggregate({
      where: { storeId, status: 'FULFILLED', fulfilledAt: { not: null } },
      _min: { fulfilledAt: true },
    });
    return agg._min.fulfilledAt ?? null;
  }

  /** Business date of the store's earliest recorded sale (live or imported), or null if none. */
  async firstActivityKey(storeId: number): Promise<string | null> {
    const [orders, imported] = await Promise.all([
      this.cutover(storeId),
      this.prisma.historicalSale.aggregate({ where: { storeId }, _min: { soldAt: true } }),
    ]);
    const candidates = [orders, imported._min.soldAt].filter((d): d is Date => d instanceof Date);
    if (!candidates.length) return null;
    return toBusinessDateKey(new Date(Math.min(...candidates.map((d) => d.getTime()))));
  }

  async daily(storeId: number, fromKey: string, toKey: string): Promise<RevenueLedger> {
    const startUtc = businessDateRangeToUtc(fromKey).startUtc;
    const endUtc = businessDateRangeToUtc(toKey).endUtc; // exclusive
    const offset = this.offsetMinutes(toKey);
    const cutover = await this.cutover(storeId);
    const importedEnd = cutover && cutover < endUtc ? cutover : endUtc;

    const [orderRows, returnRows, importedRows, excluded] = await Promise.all([
      this.prisma.$queryRaw<Array<{ day: string; amount: unknown; cnt: bigint; firstNo: string | null; lastNo: string | null }>>`
        SELECT DATE_FORMAT(DATE_ADD(fulfilledAt, INTERVAL ${offset} MINUTE), '%Y-%m-%d') AS day,
               SUM(totalAmount) AS amount, COUNT(*) AS cnt, MIN(orderNumber) AS firstNo, MAX(orderNumber) AS lastNo
        FROM orders
        WHERE storeId = ${storeId} AND status = 'FULFILLED'
          AND fulfilledAt >= ${startUtc} AND fulfilledAt < ${endUtc}
        GROUP BY day`,
      this.prisma.$queryRaw<Array<{ day: string; amount: unknown }>>`
        SELECT DATE_FORMAT(DATE_ADD(createdAt, INTERVAL ${offset} MINUTE), '%Y-%m-%d') AS day,
               SUM(totalRefundAmount) AS amount
        FROM return_orders
        WHERE storeId = ${storeId} AND status = 'COMPLETED'
          AND createdAt >= ${startUtc} AND createdAt < ${endUtc}
        GROUP BY day`,
      importedEnd > startUtc
        ? this.prisma.$queryRaw<Array<{ day: string; amount: unknown }>>`
            SELECT DATE_FORMAT(DATE_ADD(soldAt, INTERVAL ${offset} MINUTE), '%Y-%m-%d') AS day,
                   SUM(totalAmount) AS amount
            FROM historical_sales
            WHERE storeId = ${storeId} AND soldAt >= ${startUtc} AND soldAt < ${importedEnd}
            GROUP BY day`
        : Promise.resolve([]),
      cutover && cutover < endUtc
        ? this.prisma.historicalSale.count({
            where: { storeId, soldAt: { gte: cutover > startUtc ? cutover : startUtc, lt: endUtc } },
          })
        : Promise.resolve(0),
    ]);

    const byDay = new Map<string, { sales: number; imported: number; returns: number; orderCount: number; firstOrderNo: string | null; lastOrderNo: string | null }>();
    const entry = (day: string) => {
      let e = byDay.get(day);
      if (!e) {
        e = { sales: 0, imported: 0, returns: 0, orderCount: 0, firstOrderNo: null, lastOrderNo: null };
        byDay.set(day, e);
      }
      return e;
    };
    for (const r of orderRows) {
      const e = entry(r.day);
      e.sales += toCents(r.amount);
      e.orderCount += Number(r.cnt);
      e.firstOrderNo = r.firstNo;
      e.lastOrderNo = r.lastNo;
    }
    for (const r of importedRows) entry(r.day).imported += toCents(r.amount);
    for (const r of returnRows) entry(r.day).returns += toCents(r.amount);

    const days: LedgerDay[] = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, e]) => ({
        day,
        sales: fromCents(e.sales),
        imported: fromCents(e.imported),
        returns: fromCents(e.returns),
        net: fromCents(e.sales + e.imported - e.returns),
        orderCount: e.orderCount,
        firstOrderNo: e.firstOrderNo,
        lastOrderNo: e.lastOrderNo,
      }));

    return { fromKey, toKey, days, cutover, excludedImportedRows: excluded };
  }

  /** One line per order / return, for the revenue book's per-document mode. */
  async orderLines(storeId: number, fromKey: string, toKey: string): Promise<LedgerOrderLine[]> {
    const startUtc = businessDateRangeToUtc(fromKey).startUtc;
    const endUtc = businessDateRangeToUtc(toKey).endUtc;
    const [orders, returns] = await Promise.all([
      this.prisma.order.findMany({
        where: { storeId, status: 'FULFILLED', fulfilledAt: { gte: startUtc, lt: endUtc } },
        select: { orderNumber: true, fulfilledAt: true, totalAmount: true },
        orderBy: [{ fulfilledAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.returnOrder.findMany({
        where: { storeId, status: 'COMPLETED', createdAt: { gte: startUtc, lt: endUtc } },
        select: { returnNumber: true, createdAt: true, totalRefundAmount: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return [
      ...orders.map((o) => ({ day: toBusinessDateKey(o.fulfilledAt!), reference: o.orderNumber, kind: 'SALE' as const, amount: fromCents(toCents(o.totalAmount)) })),
      ...returns.map((r) => ({ day: toBusinessDateKey(r.createdAt), reference: r.returnNumber, kind: 'RETURN' as const, amount: fromCents(toCents(r.totalRefundAmount)) })),
    ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.kind === b.kind ? 0 : a.kind === 'SALE' ? -1 : 1));
  }
}
