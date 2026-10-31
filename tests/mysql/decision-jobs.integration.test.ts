import { PrismaClient } from '@prisma/client';
import { DbLeaseService } from '../../src/common/services/db-lease.service';
import { BusinessSyncService } from '../../src/common/services/business-sync.service';
import { DecisionJobsService } from '../../src/modules/decision-engine/decision-jobs.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';

const rawDbUrl = process.env.TEST_DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const sanitized = url.replace(/^mysql:\/\//, 'http://');
    const parsed = new URL(sanitized);
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    if (
      dbName.includes('production') ||
      dbName.includes('prod') ||
      dbName.includes('_dev') ||
      dbName.includes('dev_')
    ) {
      return false;
    }

    return (
      dbName.includes('_test') ||
      dbName.includes('test_') ||
      dbName.includes('_ci') ||
      dbName.includes('ci_')
    );
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));
const NIGHTLY_LAST_RUN_KEY = 'job:decision-nightly:last-run';

(isLiveDb ? describe : describe.skip)('MySQL Decision Engine triggers and jobs', () => {
  let prisma: PrismaClient;
  let jobs: DecisionJobsService;
  let leases: DbLeaseService;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    jobs = new DecisionJobsService(prisma);
    leases = new DbLeaseService(prisma);
  });

  afterAll(async () => {
    await BusinessSyncService.getInstance(prisma).flush();
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: 'lease:test-' } } });
    await prisma.systemSetting.deleteMany({ where: { key: NIGHTLY_LAST_RUN_KEY } });
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createStore(skuCount: number) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: { name: `Jobs Store ${suffix}`, code: `jobs-store-${suffix}`.replace(/_/g, '-') },
    });
    createdStoreIds.push(store.id);
    const owner = await prisma.user.create({
      data: {
        email: `jobs_owner_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Jobs Owner',
        role: 'SHOP_OWNER',
        storeId: store.id,
      },
    });
    const warehouse = await prisma.warehouse.create({ data: { storeId: store.id, name: 'Main', isDefault: true } });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `Jobs Product ${suffix}`, code: `JOBS_PRD_${suffix}` },
    });

    const stockItemIds: number[] = [];
    for (let index = 0; index < skuCount; index++) {
      const stockItem = await prisma.stockItem.create({
        data: {
          storeId: store.id,
          productId: product.id,
          sku: `SKU-JOBS-${suffix}-${index}`,
          name: `Jobs Item ${index}`,
          costPrice: 100000,
          sellingPrice: 150000,
          minStockLevel: 5,
          maxStockLevel: 100,
        },
      });
      await prisma.inventoryBalance.create({
        data: { storeId: store.id, warehouseId: warehouse.id, stockItemId: stockItem.id, quantity: 0 },
      });
      stockItemIds.push(stockItem.id);
    }

    return { store, owner, warehouse, stockItemIds };
  }

  describe('DbLeaseService', () => {
    it('grants a lease to one holder at a time, releases it, and lets an expired lease be taken over', async () => {
      const name = `test-${Date.now()}`;
      const first = await leases.tryAcquire(name, 60_000);
      expect(first).toEqual(expect.any(String));
      expect(await leases.tryAcquire(name, 60_000)).toBeNull();

      await leases.release(name, 'not-the-holder');
      expect(await leases.tryAcquire(name, 60_000)).toBeNull();

      await leases.release(name, first!);
      const second = await leases.tryAcquire(name, 1);
      expect(second).toEqual(expect.any(String));

      await new Promise((resolve) => setTimeout(resolve, 20));
      const takeover = await leases.tryAcquire(name, 60_000);
      expect(takeover).toEqual(expect.any(String));
      expect(takeover).not.toBe(second);
      await leases.release(name, takeover!);
    });

    it('lets exactly one of several concurrent contenders win', async () => {
      const name = `test-race-${Date.now()}`;
      const tokens = await Promise.all(Array.from({ length: 5 }, () => leases.tryAcquire(name, 60_000)));
      expect(tokens.filter(Boolean)).toHaveLength(1);
      await leases.release(name, tokens.find(Boolean)!);
    });
  });

  describe('recalculateStore', () => {
    it('processes a bounded page and continues from the cursor', async () => {
      const { store, stockItemIds } = await createStore(3);

      const first = await jobs.recalculateStore(store.id, { limit: 2 });
      expect(first).toMatchObject({ totalSkus: 3, processed: 2, successCount: 2, failureCount: 0, remaining: 1 });
      expect(first.nextCursor).toBe(stockItemIds[1]);

      const second = await jobs.recalculateStore(store.id, { afterId: first.nextCursor!, limit: 2 });
      expect(second).toMatchObject({ processed: 1, remaining: 0, nextCursor: null, summariesUpdatedDays: 0 });

      const snapshotted = await prisma.decisionSnapshot.groupBy({ by: ['stockItemId'], where: { storeId: store.id } });
      expect(snapshotted.map((row) => row.stockItemId).sort()).toEqual([...stockItemIds].sort());
    });

    it('rejects a concurrent recalculation of the same store with 409', async () => {
      const { store } = await createStore(2);

      const results = await Promise.allSettled([jobs.recalculateStore(store.id), jobs.recalculateStore(store.id)]);
      const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ statusCode: 409, message: 'DECISION_RECALCULATION_IN_PROGRESS' });
    });
  });

  describe('runNightly', () => {
    it('reconciles every SKU once per business date, expires overdue recommendations, and prunes old snapshots', async () => {
      await prisma.systemSetting.deleteMany({ where: { key: NIGHTLY_LAST_RUN_KEY } });
      const { store, stockItemIds } = await createStore(3);
      // The third SKU is inactive: the nightly run does not recompute it, so only the expiresAt sweep
      // can expire its overdue recommendation (active SKUs are expired by the recompute itself).
      const inactiveStockItemId = stockItemIds.pop()!;
      await prisma.stockItem.update({ where: { id: inactiveStockItemId }, data: { isActive: false } });
      const overdue = await prisma.pricingRecommendation.create({
        data: {
          storeId: store.id,
          stockItemId: inactiveStockItemId,
          currentPrice: 150000,
          recommendedPrice: 160000,
          discountPct: 0,
          action: 'INCREASE',
          reasonJson: {},
          status: 'PENDING',
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const ancient = await prisma.decisionSnapshot.create({
        data: {
          storeId: store.id,
          stockItemId: stockItemIds[1],
          calculatedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
          inputJson: {},
          metricsJson: {},
          risksJson: {},
        },
      });

      const report = await jobs.runNightly();

      expect(report).not.toBeNull();
      expect(report!.processedSkus).toBeGreaterThanOrEqual(2);
      expect(report!.expiredRecommendations).toBeGreaterThanOrEqual(1);
      expect(report!.prunedSnapshots).toBeGreaterThanOrEqual(1);
      expect((await prisma.pricingRecommendation.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe('EXPIRED');
      expect(await prisma.decisionSnapshot.findUnique({ where: { id: ancient.id } })).toBeNull();
      for (const stockItemId of stockItemIds) {
        expect(await prisma.decisionSnapshot.count({ where: { storeId: store.id, stockItemId } })).toBe(1);
      }

      expect(await jobs.runNightly()).toBeNull();
      expect(await prisma.decisionSnapshot.count({ where: { storeId: store.id } })).toBe(2);
    });
  });

  describe('post-commit triggers', () => {
    it('recomputes a SKU after an inventory inflow commits, through the coalescing queue', async () => {
      const { store, owner, warehouse, stockItemIds } = await createStore(1);
      const [stockItemId] = stockItemIds;
      await jobs.recalculateStore(store.id);
      expect(await prisma.alert.findFirst({ where: { storeId: store.id, stockItemId, type: 'STOCKOUT', status: 'OPEN' } })).not.toBeNull();

      await new InventoryService(prisma).inflow(store.id, owner.id, {
        warehouseId: warehouse.id,
        items: [{ stockItemId, quantity: 50 }],
      });
      await BusinessSyncService.getInstance(prisma).flush();

      const stockout = await prisma.alert.findFirstOrThrow({ where: { storeId: store.id, stockItemId, type: 'STOCKOUT' } });
      expect(stockout.status).toBe('RESOLVED');
      const latest = await prisma.decisionSnapshot.findFirstOrThrow({
        where: { storeId: store.id, stockItemId },
        orderBy: { id: 'desc' },
      });
      expect((latest.inputJson as any).inventory.available).toBe(50);
    });
  });
});
