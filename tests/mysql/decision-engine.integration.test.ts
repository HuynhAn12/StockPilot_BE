import { PrismaClient } from '@prisma/client';
import { DecisionEngineService } from '../../src/modules/decision-engine/decision-engine.service';
import { PricingService } from '../../src/modules/pricing/pricing.service';
import { AlertService } from '../../src/modules/alerts/alert.service';

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

/**
 * Read/write separation of the Decision Engine against real MySQL:
 * - read paths (getSkuDecision, getOverview) never write;
 * - recomputeSku is atomic, idempotent, and safe under concurrency;
 * - snapshots round-trip to the same analysis and report staleness after source changes.
 */
(isLiveDb ? describe : describe.skip)('MySQL Decision Engine read/write separation', () => {
  let prisma: PrismaClient;
  let service: DecisionEngineService;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    service = new DecisionEngineService(prisma);
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Out of stock and priced below the 20% gross-margin floor => STOCKOUT alert + INCREASE recommendation. */
  async function createFixture() {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: { name: `Decision Store ${suffix}`, code: `dec-store-${suffix}`.replace(/_/g, '-') },
    });
    createdStoreIds.push(store.id);

    const owner = await prisma.user.create({
      data: {
        email: `decision_owner_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Decision Owner',
        role: 'SHOP_OWNER',
        storeId: store.id,
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: { storeId: store.id, name: 'Main', isDefault: true },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `Decision Product ${suffix}`, code: `DEC_PRD_${suffix}` },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU-DEC-${suffix}`,
        name: `Decision StockItem ${suffix}`,
        costPrice: 100000,
        sellingPrice: 120000,
        minStockLevel: 5,
        maxStockLevel: 100,
      },
    });
    await prisma.inventoryBalance.create({
      data: { storeId: store.id, warehouseId: warehouse.id, stockItemId: stockItem.id, quantity: 0 },
    });

    return { store, owner, warehouse, stockItem };
  }

  async function countDerivedRows(storeId: number) {
    const [alerts, recommendations, snapshots, notifications] = await Promise.all([
      prisma.alert.count({ where: { storeId } }),
      prisma.pricingRecommendation.count({ where: { storeId } }),
      prisma.decisionSnapshot.count({ where: { storeId } }),
      prisma.notification.count({ where: { storeId } }),
    ]);
    return { alerts, recommendations, snapshots, notifications };
  }

  it('read paths never write, and fall back to a LIVE stale result when no snapshot exists', async () => {
    const { store, stockItem } = await createFixture();
    const before = await countDerivedRows(store.id);

    const single = await service.getSkuDecision(store.id, stockItem.id);
    const overview = await service.getOverview(store.id, { riskFilter: 'ALL', page: 1, limit: 50 });

    expect(single.freshness).toEqual({ stale: true, snapshotAt: null, source: 'LIVE' });
    expect(single.analysis.inventory.available).toBe(0);
    expect(overview.items[0].freshness.source).toBe('LIVE');
    expect(await countDerivedRows(store.id)).toEqual(before);
  });

  it('recomputeSku is idempotent: one alert, one PENDING recommendation, notifications only once', async () => {
    const { store, stockItem } = await createFixture();

    await service.recomputeSku(store.id, stockItem.id);
    const afterFirst = await countDerivedRows(store.id);
    await service.recomputeSku(store.id, stockItem.id);
    const afterSecond = await countDerivedRows(store.id);

    expect(afterFirst.alerts).toBe(1);
    expect(afterFirst.recommendations).toBe(1);
    expect(afterFirst.notifications).toBe(1);
    expect(afterSecond).toEqual({ ...afterFirst, snapshots: afterFirst.snapshots + 1 });

    const alert = await prisma.alert.findFirstOrThrow({ where: { storeId: store.id } });
    expect(alert).toMatchObject({ type: 'STOCKOUT', status: 'OPEN' });
    const rec = await prisma.pricingRecommendation.findFirstOrThrow({ where: { storeId: store.id } });
    expect(rec).toMatchObject({ status: 'PENDING', action: 'INCREASE' });
  });

  it('serializes concurrent recomputations of the same SKU without duplicates or errors', async () => {
    const { store, stockItem } = await createFixture();

    const results = await Promise.allSettled([
      service.recomputeSku(store.id, stockItem.id),
      service.recomputeSku(store.id, stockItem.id),
      service.recomputeSku(store.id, stockItem.id),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const counts = await countDerivedRows(store.id);
    expect(counts).toMatchObject({ alerts: 1, recommendations: 1, snapshots: 3 });
  });

  it('round-trips the snapshot to the same analysis and reads it without re-evaluating', async () => {
    const { store, stockItem } = await createFixture();
    const computed = await service.recomputeSku(store.id, stockItem.id);

    const evaluateSpy = jest.spyOn(DecisionEngineService.prototype as any, 'evaluateSku');
    const read = await service.getSkuDecision(store.id, stockItem.id);
    const overview = await service.getOverview(store.id, { riskFilter: 'STOCKOUT', page: 1, limit: 50 });

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(read.freshness).toMatchObject({ stale: false, source: 'SNAPSHOT' });
    expect(read.analysis).toEqual(computed);
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toEqual({ analysis: computed, freshness: read.freshness });
  });

  it('marks the snapshot stale after an inventory movement or price change until the next recompute', async () => {
    const { store, warehouse, stockItem } = await createFixture();
    await service.recomputeSku(store.id, stockItem.id);
    expect((await service.getSkuDecision(store.id, stockItem.id)).freshness.stale).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await prisma.stockMovement.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: stockItem.id,
        type: 'INFLOW',
        delta: 10,
        beforeQuantity: 0,
        afterQuantity: 10,
        referenceType: 'TEST',
        referenceId: 'stale-check',
      },
    });
    expect((await service.getSkuDecision(store.id, stockItem.id)).freshness.stale).toBe(true);

    await service.recomputeSku(store.id, stockItem.id);
    expect((await service.getSkuDecision(store.id, stockItem.id)).freshness.stale).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await prisma.stockItem.update({ where: { id: stockItem.id }, data: { sellingPrice: 130000 } });
    expect((await service.getSkuDecision(store.id, stockItem.id)).freshness.stale).toBe(true);
  });

  it('treats snapshots of an older JSON shape as missing', async () => {
    const { store, stockItem } = await createFixture();
    await prisma.decisionSnapshot.create({
      data: {
        storeId: store.id,
        stockItemId: stockItem.id,
        inputJson: { costPrice: 100000 },
        metricsJson: { reorderPoint: 15, safetyStock: 8 },
        risksJson: { stockoutRisk: 'LOW' },
      },
    });

    const read = await service.getSkuDecision(store.id, stockItem.id);
    expect(read.freshness.source).toBe('LIVE');
  });

  it('returns 404 for another store SKU on both read and write paths without locking or writing', async () => {
    const a = await createFixture();
    const b = await createFixture();

    await expect(service.getSkuDecision(b.store.id, a.stockItem.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.recomputeSku(b.store.id, a.stockItem.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await countDerivedRows(b.store.id)).toEqual({ alerts: 0, recommendations: 0, snapshots: 0, notifications: 0 });
  });

  describe('V2 formulas on real data', () => {
    it('flags a never-sold SKU stocked long ago as dead stock (age since first stock-in)', async () => {
      const { store, warehouse, stockItem } = await createFixture();
      const stockedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
      await prisma.stockMovement.create({
        data: {
          storeId: store.id,
          warehouseId: warehouse.id,
          stockItemId: stockItem.id,
          type: 'INFLOW',
          delta: 40,
          beforeQuantity: 0,
          afterQuantity: 40,
          referenceType: 'TEST',
          referenceId: 'first-stock-in',
          createdAt: stockedAt,
        },
      });
      await prisma.inventoryBalance.updateMany({ where: { stockItemId: stockItem.id }, data: { quantity: 40 } });

      const result = await service.recomputeSku(store.id, stockItem.id);

      expect(result.risk.daysSinceLastSale).toBeNull();
      expect(result.risk.daysWithoutSale).toBeGreaterThanOrEqual(119);
      expect(result.risk.deadStock).toBe(true);
      expect(result.dataStatus).toBe('OK');
      expect(await prisma.alert.findFirst({ where: { storeId: store.id, type: 'DEAD_STOCK', status: 'OPEN' } })).not.toBeNull();
    });
  });

  describe('Pricing recommendation lifecycle', () => {
    it('expires a PENDING recommendation once the engine stops recommending a change', async () => {
      const { store, stockItem } = await createFixture();
      await service.recomputeSku(store.id, stockItem.id);
      const pending = await prisma.pricingRecommendation.findFirstOrThrow({ where: { storeId: store.id, status: 'PENDING' } });

      // Price now respects the 20% gross-margin floor and the SKU has no demand history => MAINTAIN.
      await prisma.stockItem.update({ where: { id: stockItem.id }, data: { sellingPrice: 150000 } });
      await service.recomputeSku(store.id, stockItem.id);

      expect((await prisma.pricingRecommendation.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('EXPIRED');
      expect(await prisma.pricingRecommendation.count({ where: { storeId: store.id, status: 'PENDING' } })).toBe(0);
    });

    it('rejects accepting a recommendation after the cost price changed, without touching the price', async () => {
      const { store, owner, stockItem } = await createFixture();
      await service.recomputeSku(store.id, stockItem.id);
      const pending = await prisma.pricingRecommendation.findFirstOrThrow({ where: { storeId: store.id, status: 'PENDING' } });
      await prisma.stockItem.update({ where: { id: stockItem.id }, data: { costPrice: 110000 } });

      await expect(new PricingService(prisma).acceptRecommendation(store.id, owner.id, pending.id)).rejects.toMatchObject({
        statusCode: 409,
        message: 'STALE_PRICING_RECOMMENDATION_COST_CHANGED',
      });
      expect(Number((await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } })).sellingPrice)).toBe(120000);
      expect(await prisma.priceHistory.count({ where: { storeId: store.id } })).toBe(0);
    });

    it('rejects accepting a recommendation that falls below the floor of the current margin policy', async () => {
      const { store, owner, stockItem } = await createFixture();
      await service.recomputeSku(store.id, stockItem.id);
      const pending = await prisma.pricingRecommendation.findFirstOrThrow({ where: { storeId: store.id, status: 'PENDING' } });
      // Recommended 125,000 was computed for a 20% margin; the owner then raises the floor to 30%.
      await prisma.engineConfig.create({ data: { storeId: store.id, minimumMarginPct: 0.3 } });

      await expect(new PricingService(prisma).acceptRecommendation(store.id, owner.id, pending.id)).rejects.toMatchObject({
        statusCode: 409,
        message: 'PRICING_RECOMMENDATION_BELOW_FLOOR',
      });
    });

    it('accepts a still-valid recommendation and records PriceHistory atomically', async () => {
      const { store, owner, stockItem } = await createFixture();
      await service.recomputeSku(store.id, stockItem.id);
      const pending = await prisma.pricingRecommendation.findFirstOrThrow({ where: { storeId: store.id, status: 'PENDING' } });

      const accepted = await new PricingService(prisma).acceptRecommendation(store.id, owner.id, pending.id);

      expect(accepted.status).toBe('ACCEPTED');
      const history = await prisma.priceHistory.findFirstOrThrow({ where: { storeId: store.id } });
      expect(Number(history.newPrice)).toBe(Number(pending.recommendedPrice));
      expect(Number((await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } })).sellingPrice)).toBe(Number(pending.recommendedPrice));
    });
  });

  describe('Alert lifecycle (edge-triggered reopen)', () => {
    it('keeps a user-resolved alert closed while its condition persists and reopens it after the condition clears and recurs', async () => {
      const { store, owner, stockItem } = await createFixture();
      const alerts = new AlertService(prisma);
      await service.recomputeSku(store.id, stockItem.id);
      const stockout = await prisma.alert.findFirstOrThrow({ where: { storeId: store.id, type: 'STOCKOUT' } });

      await alerts.resolveAlert(store.id, stockout.id, owner.id);
      await service.recomputeSku(store.id, stockItem.id);
      expect((await prisma.alert.findUniqueOrThrow({ where: { id: stockout.id } })).status).toBe('RESOLVED');

      // Condition clears: restocked.
      await prisma.inventoryBalance.updateMany({ where: { stockItemId: stockItem.id }, data: { quantity: 50 } });
      await service.recomputeSku(store.id, stockItem.id);
      const cleared = await prisma.alert.findUniqueOrThrow({ where: { id: stockout.id } });
      expect(cleared.status).toBe('RESOLVED');
      expect((cleared.reasonJson as any).lifecycle.resolvedBy).toBe('ENGINE');

      // Condition recurs: sold out again => the same alert reopens and operators are notified.
      const notificationsBefore = await prisma.notification.count({ where: { storeId: store.id, entityId: String(stockout.id) } });
      await prisma.inventoryBalance.updateMany({ where: { stockItemId: stockItem.id }, data: { quantity: 0 } });
      await service.recomputeSku(store.id, stockItem.id);
      expect((await prisma.alert.findUniqueOrThrow({ where: { id: stockout.id } })).status).toBe('OPEN');
      expect(await prisma.notification.count({ where: { storeId: store.id, entityId: String(stockout.id) } })).toBe(notificationsBefore + 1);
    });
  });
});
