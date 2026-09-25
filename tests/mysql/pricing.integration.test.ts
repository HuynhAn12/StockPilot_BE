import { Prisma, PrismaClient } from '@prisma/client';
import { PricingService } from '../../src/modules/pricing/pricing.service';

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

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real Pricing Recommendation Consistency Integration', () => {
  let prisma: PrismaClient;
  let pricingService: PricingService;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    pricingService = new PricingService(prisma);
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createFixture() {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: {
        name: `Pricing Store ${suffix}`,
        code: `PRICE_STORE_${suffix}`,
      },
    });
    createdStoreIds.push(store.id);

    const user = await prisma.user.create({
      data: {
        email: `pricing_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Pricing User',
        role: 'SHOP_OWNER',
        storeId: store.id,
      },
    });

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `Pricing Product ${suffix}`,
        code: `PRICE_PRD_${suffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU-PRICE-${suffix}`,
        name: `Pricing StockItem ${suffix}`,
        costPrice: 100000,
        sellingPrice: 200000,
      },
    });

    return { store, user, stockItem };
  }

  async function createPendingRecommendation(storeId: number, stockItemId: number) {
    return prisma.pricingRecommendation.create({
      data: {
        storeId,
        stockItemId,
        currentPrice: 200000,
        recommendedPrice: 164000,
        discountPct: 18,
        action: 'DECREASE',
        riskScore: 60,
        confidence: 80,
        reasonJson: { test: true },
        status: 'PENDING',
        engineVersion: 'DECISION_ENGINE_V1',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }

  async function expectExactlyOneWinner(results: PromiseSettledResult<unknown>[]) {
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  }

  it('accept vs accept: exactly one decision wins and one price history row is written', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await createPendingRecommendation(store.id, stockItem.id);

    const results = await Promise.allSettled([
      pricingService.acceptRecommendation(store.id, user.id, rec.id, true),
      pricingService.acceptRecommendation(store.id, user.id, rec.id, true),
    ]);

    await expectExactlyOneWinner(results);

    const finalRec = await prisma.pricingRecommendation.findUniqueOrThrow({ where: { id: rec.id } });
    const histories = await prisma.priceHistory.findMany({ where: { recommendationId: rec.id } });

    expect(finalRec.status).toBe('ACCEPTED');
    expect(histories).toHaveLength(1);
  });

  it('accept vs reject: exactly one decision wins', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await createPendingRecommendation(store.id, stockItem.id);

    const results = await Promise.allSettled([
      pricingService.acceptRecommendation(store.id, user.id, rec.id, true),
      pricingService.rejectRecommendation(store.id, user.id, rec.id),
    ]);

    await expectExactlyOneWinner(results);

    const finalRec = await prisma.pricingRecommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(['ACCEPTED', 'REJECTED']).toContain(finalRec.status);
  });

  it('accept vs modify: exactly one decision wins', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await createPendingRecommendation(store.id, stockItem.id);

    const results = await Promise.allSettled([
      pricingService.acceptRecommendation(store.id, user.id, rec.id, true),
      pricingService.modifyRecommendation(store.id, user.id, rec.id, 170000, true),
    ]);

    await expectExactlyOneWinner(results);

    const finalRec = await prisma.pricingRecommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(['ACCEPTED', 'MODIFIED']).toContain(finalRec.status);
  });

  it('expired recommendation cannot update StockItem price', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await prisma.pricingRecommendation.create({
      data: {
        storeId: store.id,
        stockItemId: stockItem.id,
        currentPrice: 200000,
        recommendedPrice: 164000,
        discountPct: 18,
        action: 'DECREASE',
        riskScore: 60,
        confidence: 80,
        reasonJson: { test: true },
        status: 'PENDING',
        engineVersion: 'DECISION_ENGINE_V1',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(pricingService.acceptRecommendation(store.id, user.id, rec.id, true)).rejects.toThrow(
      'PRICING_RECOMMENDATION_EXPIRED'
    );

    const unchanged = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(Number(unchanged.sellingPrice)).toBe(200000);
  });

  it('stale recommendation cannot overwrite a newer StockItem price', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await createPendingRecommendation(store.id, stockItem.id);

    await prisma.stockItem.update({
      where: { id: stockItem.id },
      data: { sellingPrice: 210000 },
    });

    await expect(pricingService.acceptRecommendation(store.id, user.id, rec.id, true)).rejects.toThrow(
      'STALE_PRICING_RECOMMENDATION'
    );

    const unchanged = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(Number(unchanged.sellingPrice)).toBe(210000);
  });

  it('manual modify enforces gross margin floor, not just cost price', async () => {
    const { store, user, stockItem } = await createFixture();
    const rec = await createPendingRecommendation(store.id, stockItem.id);

    await expect(pricingService.modifyRecommendation(store.id, user.id, rec.id, 120000, true)).rejects.toThrow(
      'minimum margin floor'
    );

    const unchanged = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(Number(unchanged.sellingPrice)).toBe(200000);
  });

  it('concurrent Decision Engine pricing sync creates only one PENDING recommendation per SKU', async () => {
    const { store, stockItem } = await createFixture();
    const input = {
      storeId: store.id,
      stockItemId: stockItem.id,
      sellingPrice: 200000,
      costPrice: 100000,
      minimumMarginPct: 0.2,
      maxMarkdownPct: 0.3,
      maxMarkupPct: 0.2,
      daysSinceLastSale: 120,
      daysOfCover: 90,
      overstockScore: 70,
      stockoutScore: 0,
      trend: 'DOWN' as const,
      confidenceScore: 80,
    };

    const results = await Promise.allSettled([
      pricingService.evaluatePricingRecommendation(input),
      pricingService.evaluatePricingRecommendation(input),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const pending = await prisma.pricingRecommendation.findMany({
      where: {
        storeId: store.id,
        stockItemId: stockItem.id,
        status: 'PENDING',
      },
    });

    expect(pending).toHaveLength(1);
    expect(Number(pending[0].currentPrice)).toBe(200000);
    expect(new Prisma.Decimal(pending[0].recommendedPrice).gt(0)).toBe(true);
  });
});
