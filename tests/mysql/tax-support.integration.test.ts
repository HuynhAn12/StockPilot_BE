import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { RevenueLedgerService } from '../../src/modules/tax-support/revenue-ledger.service';
import { TaxSupportService } from '../../src/modules/tax-support/tax-support.service';

/**
 * Real MySQL: the revenue ledger's raw SQL (table/column names, Vietnam-time day buckets, half-open
 * windows), the import cutover rule, unmatched imported rows, cancelled orders and store isolation.
 */

const rawDbUrl = process.env.TEST_DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const dbName = new URL(url.replace(/^mysql:\/\//, 'http://')).pathname.replace(/^\//, '').toLowerCase();
    if (dbName.includes('production') || dbName.includes('prod') || dbName.includes('_dev') || dbName.includes('dev_')) return false;
    return dbName.includes('_test') || dbName.includes('test_') || dbName.includes('_ci') || dbName.includes('ci_');
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));

(isLiveDb ? describe : describe.skip)('MySQL tax support revenue ledger', () => {
  let prisma: PrismaClient;
  let ledger: RevenueLedgerService;
  let service: TaxSupportService;
  let storeId: number;
  let otherStoreId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    ledger = new RevenueLedgerService(prisma);
    service = new TaxSupportService(prisma, ledger);

    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({ data: { name: `Tax Store ${suffix}`, code: `TAX_${suffix}`, address: '12 Lê Lợi' } });
    const other = await prisma.store.create({ data: { name: `Other Store ${suffix}`, code: `TAXO_${suffix}` } });
    storeId = store.id;
    otherStoreId = other.id;

    const order = (orderNumber: string, fulfilledAt: Date, totalAmount: number, status: 'FULFILLED' | 'CANCELED' | 'DRAFT' = 'FULFILLED', sid = storeId) =>
      prisma.order.create({ data: { storeId: sid, orderNumber, status, fulfilledAt, totalAmount } });

    // 23:30 on 31/12 in Vietnam (16:30 UTC) belongs to 2025; 00:30 on 01/01 (17:30 UTC) belongs to 2026.
    await order('HD-A', new Date('2025-12-31T16:30:00Z'), 100_000);
    await order('HD-B', new Date('2025-12-31T17:30:00Z'), 200_000.5);
    const c = await order('HD-C', new Date('2026-03-10T03:00:00Z'), 300_000);
    await order('HD-D', new Date('2026-03-10T04:00:00Z'), 999_999, 'CANCELED');
    await order('HD-E', new Date('2026-03-10T05:00:00Z'), 888_888, 'DRAFT');
    await order('HD-X', new Date('2026-03-10T03:00:00Z'), 5_000_000, 'FULFILLED', otherStoreId);

    await prisma.returnOrder.create({
      data: { storeId, orderId: c.id, returnNumber: 'TH-1', totalRefundAmount: 50_000, createdAt: new Date('2026-03-11T03:00:00Z') },
    });

    const imported = (hash: string, soldAt: Date, totalAmount: number) =>
      prisma.historicalSale.create({
        data: { storeId, stockItemId: null, externalSku: 'KV-UNMATCHED', quantity: 1, unitPrice: totalAmount, totalAmount, soldAt, source: 'KIOTVIET', sourceRowHash: hash },
      });
    await imported(`h1_${suffix}`, new Date('2025-06-01T03:00:00Z'), 400_000); // before the first StockPilot sale → counted
    await imported(`h2_${suffix}`, new Date('2026-02-01T03:00:00Z'), 700_000); // after it → overlaps live sales, skipped
  });

  afterAll(async () => {
    for (const id of [storeId, otherStoreId]) {
      if (id) await prisma.store.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('buckets sales by Vietnam business day around New Year', async () => {
    const result = await ledger.daily(storeId, '2025-12-31', '2026-01-01');
    expect(result.days.map((d) => [d.day, d.sales, d.orderCount])).toEqual([
      ['2025-12-31', 100_000, 1],
      ['2026-01-01', 200_000.5, 1],
    ]);
  });

  it('counts unmatched imported history only before the first StockPilot sale, and never other stores, drafts or cancellations', async () => {
    const result = await ledger.daily(storeId, '2025-01-01', '2026-12-31');
    expect(result.cutover?.toISOString()).toBe('2025-12-31T16:30:00.000Z');
    expect(result.excludedImportedRows).toBe(1);
    expect(result.days.map((d) => [d.day, d.sales, d.imported, d.returns, d.net])).toEqual([
      ['2025-06-01', 0, 400_000, 0, 400_000],
      ['2025-12-31', 100_000, 0, 0, 100_000],
      ['2026-01-01', 200_000.5, 0, 0, 200_000.5],
      ['2026-03-10', 300_000, 0, 0, 300_000],
      ['2026-03-11', 0, 0, 50_000, -50_000],
    ]);
    expect(await ledger.firstActivityKey(storeId)).toBe('2025-06-01');
  });

  it('computes the threshold snapshot from the same ledger', async () => {
    const r = await service.getRevenueThreshold(storeId, new Date('2026-03-15T03:00:00Z'));
    expect(r).toMatchObject({
      year: 2026,
      ytdRevenue: 450_000.5,
      priorYearRevenue: 500_000,
      breakdown: { sales: 500_000.5, imported: 0, returns: 50_000 },
      level: 'NONE',
    });
    expect(r.notes.some((n) => n.includes('Bỏ qua 1 dòng lịch sử'))).toBe(true);
  });

  it('builds a revenue book whose total equals the ledger net for the period', async () => {
    const now = new Date('2026-03-15T03:00:00Z');
    const preview = await service.previewRevenueBook(storeId, { template: 'S1A', period: 'quarter', year: 2026, quarter: 1, granularity: 'day' }, now);
    expect(preview).toMatchObject({ total: 450_000.5, lineCount: 3, partialUntil: '2026-03-15', breakdown: { sales: 500_000.5, imported: 0, returns: 50_000 } });

    const { csv, filename } = await service.exportRevenueBook(storeId, { template: 'S2A', period: 'quarter', year: 2026, quarter: 1, granularity: 'order' }, now);
    expect(filename).toBe('so-doanh-thu-S2a-2026-Q1.csv');
    expect(csv).toContain('HD-B,01/01/2026,Bán hàng hóa,200000.50,');
    expect(csv).toContain('TH-1,11/03/2026,Hàng bán bị trả lại,-50000,');
    expect(csv).not.toContain('HD-D');
    expect(csv).not.toContain('HD-X');
  });
});
