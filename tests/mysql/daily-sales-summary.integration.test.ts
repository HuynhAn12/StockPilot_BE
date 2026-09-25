import { PrismaClient } from '@prisma/client';
import { DailySalesSummaryService } from '../../src/modules/daily-sales-summary/daily-sales-summary.service';
import { OrderService } from '../../src/modules/orders/order.service';
import { ReturnService } from '../../src/modules/returns/return.service';
import { HistoricalSalesService } from '../../src/modules/historical-sales/historical-sales.service';
import { runRebuildDailySalesSummaryV10 } from '../../scripts/rebuild-daily-sales-summary-v10';
import { DecisionEngineService } from '../../src/modules/decision-engine/decision-engine.service';

/**
 * Real MySQL 8.4 DailySalesSummary Integration Test Suite
 *
 * Tests real database transactions, decimal aggregations, realized revenue,
 * return COGS accounting policies, and V10 backfill reconciliation without any mocks.
 */

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

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real DailySalesSummary & Return COGS Accounting Integration', () => {
  let prisma: PrismaClient;
  let summaryService: DailySalesSummaryService;
  let orderService: OrderService;
  let returnService: ReturnService;
  let historicalSalesService: HistoricalSalesService;
  let decisionEngineService: DecisionEngineService;

  let storeId: number;
  let warehouseId: number;
  let userId: number;
  let stockItemId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();

    summaryService = new DailySalesSummaryService(prisma);
    orderService = new OrderService(prisma);
    returnService = new ReturnService(prisma);
    historicalSalesService = new HistoricalSalesService(prisma);
    decisionEngineService = new DecisionEngineService(prisma);

    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // Create isolated store tenant
    const store = await prisma.store.create({
      data: {
        name: `Summary Test Store ${suffix}`,
        code: `SUMM_STORE_${suffix}`,
      },
    });
    storeId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: 'Summary Test Warehouse',
        isDefault: true,
      },
    });
    warehouseId = warehouse.id;

    const user = await prisma.user.create({
      data: {
        email: `summary_tester_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Summary Tester',
        role: 'SHOP_OWNER',
        storeId,
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `Test Product ${suffix}`,
        code: `PRD_${suffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId: product.id,
        sku: `SKU-SUMM-${suffix}`,
        name: `StockItem ${suffix}`,
        costPrice: 60000,
        sellingPrice: 100000,
      },
    });
    stockItemId = stockItem.id;

    // Seed inventory balance
    await prisma.inventoryBalance.create({
      data: {
        storeId,
        warehouseId,
        stockItemId,
        quantity: 100,
      },
    });
  });

  afterAll(async () => {
    if (storeId) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('Real MySQL: Day 1 Sale and Day 2 Restockable Return correctly reverse COGS using cost snapshot', async () => {
    const day1 = new Date('2026-04-01T10:00:00.000Z');
    const day2 = new Date('2026-04-02T10:00:00.000Z');

    // 1. Create and fulfill an order on Day 1 (1 unit @ 100k, cost snapshot = 60k)
    const draftOrder = await orderService.createDraftOrder(storeId, userId, {
      items: [{ stockItemId, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(storeId, userId, draftOrder.id);
    const fulfilledOrder = await orderService.fulfillOrder(storeId, draftOrder.id);

    // Manually set fulfilledAt to day1 to test exact date partition
    await prisma.order.update({
      where: { id: fulfilledOrder.id },
      data: { fulfilledAt: day1 },
    });

    // 2. Change StockItem costPrice on Day 2 (e.g., supplier increased cost to 95k)
    await prisma.stockItem.update({
      where: { id: stockItemId },
      data: { costPrice: 95000 },
    });

    // 3. Process a full restockable return on Day 2
    const orderItem = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: fulfilledOrder.id, stockItemId },
    });

    const returnOrder = await returnService.createReturn(storeId, userId, {
      orderId: fulfilledOrder.id,
      reason: 'Restockable return test',
      items: [
        {
          orderItemId: orderItem.id,
          quantity: 1,
          isRestockable: true,
        },
      ],
    });

    // Set returnOrder createdAt to day2
    await prisma.returnOrder.update({
      where: { id: returnOrder.id },
      data: { createdAt: day2 },
    });

    // 4. Rebuild DailySalesSummary across Day 1 and Day 2
    await summaryService.rebuildDailySalesSummary(storeId, day1, day2, [stockItemId]);

    // 5. Query persisted DailySalesSummary rows from MySQL
    const day1Summary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId,
          summaryDate: new Date('2026-04-01T00:00:00.000Z'),
        },
      },
    });

    const day2Summary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId,
          summaryDate: new Date('2026-04-02T00:00:00.000Z'),
        },
      },
    });

    // Day 1 Assertions:
    // revenue 100,000, COGS 60,000, profit 40,000
    expect(day1Summary.grossSoldQty).toBe(1);
    expect(day1Summary.netSoldQty).toBe(1);
    expect(Number(day1Summary.grossRevenue)).toBe(100000);
    expect(Number(day1Summary.netRevenue)).toBe(100000);
    expect(Number(day1Summary.cogs)).toBe(60000);
    expect(Number(day1Summary.grossProfit)).toBe(40000);

    // Day 2 Assertions (Return-only day):
    // netRevenue -100,000, COGS -60,000 (uses snapshot 60,000 NOT current 95,000), profit -40,000
    expect(day2Summary.grossSoldQty).toBe(0);
    expect(day2Summary.returnQty).toBe(1);
    expect(day2Summary.netSoldQty).toBe(-1);
    expect(Number(day2Summary.grossRevenue)).toBe(0);
    expect(Number(day2Summary.refundAmount)).toBe(100000);
    expect(Number(day2Summary.netRevenue)).toBe(-100000);
    expect(Number(day2Summary.cogs)).toBe(-60000);
    expect(Number(day2Summary.grossProfit)).toBe(-40000);

    // Combined Net Accounting across Day 1 + Day 2:
    const totalNetRevenue = Number(day1Summary.netRevenue) + Number(day2Summary.netRevenue);
    const totalCogs = Number(day1Summary.cogs) + Number(day2Summary.cogs);
    const totalProfit = Number(day1Summary.grossProfit) + Number(day2Summary.grossProfit);

    expect(totalNetRevenue).toBe(0);
    expect(totalCogs).toBe(0);
    expect(totalProfit).toBe(0);
  });

  it('Real MySQL: Non-restockable return does not reverse COGS in DailySalesSummary', async () => {
    const day3 = new Date('2026-04-03T10:00:00.000Z');
    const day4 = new Date('2026-04-04T10:00:00.000Z');

    // 1. Create order on Day 3
    const draftOrder = await orderService.createDraftOrder(storeId, userId, {
      items: [{ stockItemId, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(storeId, userId, draftOrder.id);
    const fulfilledOrder = await orderService.fulfillOrder(storeId, draftOrder.id);

    await prisma.order.update({
      where: { id: fulfilledOrder.id },
      data: { fulfilledAt: day3 },
    });

    const orderItem = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: fulfilledOrder.id, stockItemId },
    });

    // 2. Return on Day 4 with isRestockable = false (damaged item)
    const returnOrder = await returnService.createReturn(storeId, userId, {
      orderId: fulfilledOrder.id,
      reason: 'Damaged item - cannot restock',
      items: [
        {
          orderItemId: orderItem.id,
          quantity: 1,
          isRestockable: false,
        },
      ],
    });

    await prisma.returnOrder.update({
      where: { id: returnOrder.id },
      data: { createdAt: day4 },
    });

    // 3. Rebuild summaries for Day 4
    await summaryService.rebuildDailySalesSummary(storeId, day4, day4, [stockItemId]);

    const day4Summary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId,
          summaryDate: new Date('2026-04-04T00:00:00.000Z'),
        },
      },
    });

    // Non-restockable return on return-only day:
    // refundAmount = 100k, netRevenue = -100k, COGS = 0 (not reversed), grossProfit = -100k
    expect(day4Summary.netSoldQty).toBe(-1);
    expect(Number(day4Summary.refundAmount)).toBe(100000);
    expect(Number(day4Summary.netRevenue)).toBe(-100000);
    expect(Number(day4Summary.cogs)).toBe(0);
    expect(Number(day4Summary.grossProfit)).toBe(-100000);
  });

  it('Real MySQL: Preview and Commit of Historical Sales with costPrice persists costPriceSnapshot', async () => {
    const item = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItemId } });

    const preview = await historicalSalesService.previewHistoricalSales(storeId, userId, [
      {
        sku: item.sku,
        quantity: 3,
        unitPrice: 120000,
        costPriceSnapshot: 75000,
        soldAt: new Date('2026-02-15T10:00:00.000Z'),
        source: 'CSV',
        externalOrderId: `EXT-HIST-${Date.now()}`,
      },
    ]);

    expect(preview.validRows).toBe(1);
    expect(preview.previewSample[0].costPriceSnapshot).toBe(75000);

    const commit = await historicalSalesService.commitHistoricalSales(storeId, userId, preview.jobId);
    expect(commit.status).toBe('COMPLETED');

    const persistedSale = await prisma.historicalSale.findFirstOrThrow({
      where: { storeId, stockItemId, externalOrderId: preview.previewSample[0].externalOrderId },
    });

    expect(Number(persistedSale.costPriceSnapshot)).toBe(75000);
    expect(persistedSale.quantity).toBe(3);
  });

  it('Real MySQL: Rebuild DailySalesSummary correctly handles historical sales with and without costPriceSnapshot', async () => {
    const item = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItemId } });
    const targetDate = new Date('2026-02-20T10:00:00.000Z');
    const businessSummaryDate = new Date('2026-02-20T00:00:00.000Z');

    // 1. Create a historical sale without cost (costPriceSnapshot = null)
    await prisma.historicalSale.create({
      data: {
        storeId,
        stockItemId,
        externalSku: item.sku,
        quantity: 2,
        unitPrice: 100000,
        totalAmount: 200000,
        costPriceSnapshot: null,
        soldAt: targetDate,
        source: 'CSV',
        externalOrderId: `EXT-NOCOST-${Date.now()}`,
        sourceRowHash: `hash-nocost-${Date.now()}`,
      },
    });

    // 2. Pre-seed a stale summary row that incorrectly assumed StockItem.costPrice (e.g. 95k * 2 = 190k)
    await prisma.dailySalesSummary.upsert({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId,
          summaryDate: businessSummaryDate,
        },
      },
      create: {
        storeId,
        stockItemId,
        summaryDate: businessSummaryDate,
        grossSoldQty: 2,
        returnQty: 0,
        netSoldQty: 2,
        grossRevenue: 200000,
        refundAmount: 0,
        netRevenue: 200000,
        cogs: 190000,
        grossProfit: 10000,
        orderCount: 1,
        historicalCostMissingQty: 0,
      },
      update: {
        cogs: 190000,
        historicalCostMissingQty: 0,
      },
    });

    // 3. Run the V10 backfill reconciliation tool
    const backfillRes = await runRebuildDailySalesSummaryV10(prisma, { storeId });
    expect(backfillRes.processedStores).toBeGreaterThanOrEqual(1);

    // 4. Verify the updated summary: COGS contribution is 0, historicalCostMissingQty is 2
    const reconciledSummary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId,
          summaryDate: businessSummaryDate,
        },
      },
    });

    expect(reconciledSummary.grossSoldQty).toBe(2);
    expect(Number(reconciledSummary.cogs)).toBe(0);
    expect(reconciledSummary.historicalCostMissingQty).toBe(2);
    expect(Number(reconciledSummary.grossProfit)).toBe(200000);
  });

  it('Real MySQL: Vietnam business-day rebuild includes sales from previous UTC calendar date', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const businessDate = new Date('2026-09-25T00:00:00.000Z');
    const firstHourVietnamBusinessDay = new Date('2026-09-24T17:30:00.000Z');

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `Timezone Product ${suffix}`,
        code: `TZ_PRD_${suffix}`,
      },
    });

    const timezoneStockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId: product.id,
        sku: `SKU-TZ-${suffix}`,
        name: `Timezone StockItem ${suffix}`,
        costPrice: 40000,
        sellingPrice: 100000,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        storeId,
        warehouseId,
        stockItemId: timezoneStockItem.id,
        quantity: 10,
      },
    });

    const draftOrder = await orderService.createDraftOrder(storeId, userId, {
      items: [{ stockItemId: timezoneStockItem.id, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(storeId, userId, draftOrder.id);
    const fulfilledOrder = await orderService.fulfillOrder(storeId, draftOrder.id);

    await prisma.order.update({
      where: { id: fulfilledOrder.id },
      data: { fulfilledAt: firstHourVietnamBusinessDay },
    });

    await summaryService.rebuildDailySalesSummary(storeId, businessDate, businessDate, [timezoneStockItem.id]);

    const summary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId: timezoneStockItem.id,
          summaryDate: new Date('2026-09-25T00:00:00.000Z'),
        },
      },
    });

    expect(summary.grossSoldQty).toBe(1);
    expect(summary.netSoldQty).toBe(1);
    expect(Number(summary.cogs)).toBe(40000);
    expect(summary.historicalCostMissingQty).toBe(0);
  });

  it('Real MySQL: V10 reconciliation deletes stale UTC summary when business date shifts forward', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const staleUtcSummaryDate = new Date('2026-09-24T00:00:00.000Z');
    const businessSummaryDate = new Date('2026-09-25T00:00:00.000Z');
    const firstHourVietnamBusinessDay = new Date('2026-09-24T17:30:00.000Z');

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `Backfill TZ Product ${suffix}`,
        code: `BF_TZ_PRD_${suffix}`,
      },
    });

    const timezoneStockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId: product.id,
        sku: `SKU-BF-TZ-${suffix}`,
        name: `Backfill TZ StockItem ${suffix}`,
        costPrice: 40000,
        sellingPrice: 100000,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        storeId,
        warehouseId,
        stockItemId: timezoneStockItem.id,
        quantity: 10,
      },
    });

    const draftOrder = await orderService.createDraftOrder(storeId, userId, {
      items: [{ stockItemId: timezoneStockItem.id, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(storeId, userId, draftOrder.id);
    const fulfilledOrder = await orderService.fulfillOrder(storeId, draftOrder.id);

    await prisma.order.update({
      where: { id: fulfilledOrder.id },
      data: { fulfilledAt: firstHourVietnamBusinessDay },
    });

    await prisma.dailySalesSummary.create({
      data: {
        storeId,
        stockItemId: timezoneStockItem.id,
        summaryDate: staleUtcSummaryDate,
        grossSoldQty: 1,
        returnQty: 0,
        netSoldQty: 1,
        grossRevenue: 100000,
        refundAmount: 0,
        netRevenue: 100000,
        cogs: 40000,
        grossProfit: 60000,
        orderCount: 1,
        historicalCostMissingQty: 0,
      },
    });

    const backfillRes = await runRebuildDailySalesSummaryV10(prisma, { storeId });
    expect(backfillRes.processedStores).toBe(1);

    const staleSummary = await prisma.dailySalesSummary.findUnique({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId: timezoneStockItem.id,
          summaryDate: staleUtcSummaryDate,
        },
      },
    });
    const businessSummary = await prisma.dailySalesSummary.findUniqueOrThrow({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId: timezoneStockItem.id,
          summaryDate: businessSummaryDate,
        },
      },
    });

    expect(staleSummary).toBeNull();
    expect(businessSummary.grossSoldQty).toBe(1);
    expect(businessSummary.netSoldQty).toBe(1);
    expect(Number(businessSummary.grossRevenue)).toBe(100000);
  });

  it('Real MySQL: V10 reconciliation deletes existing stale summary when no authoritative facts remain', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const staleSummaryDate = new Date('2026-01-15T00:00:00.000Z');

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `No Source Product ${suffix}`,
        code: `NO_SRC_PRD_${suffix}`,
      },
    });

    const orphanStockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId: product.id,
        sku: `SKU-NO-SRC-${suffix}`,
        name: `No Source StockItem ${suffix}`,
        costPrice: 50000,
        sellingPrice: 90000,
      },
    });

    await prisma.dailySalesSummary.create({
      data: {
        storeId,
        stockItemId: orphanStockItem.id,
        summaryDate: staleSummaryDate,
        grossSoldQty: 3,
        returnQty: 0,
        netSoldQty: 3,
        grossRevenue: 270000,
        refundAmount: 0,
        netRevenue: 270000,
        cogs: 150000,
        grossProfit: 120000,
        orderCount: 1,
        historicalCostMissingQty: 0,
      },
    });

    await runRebuildDailySalesSummaryV10(prisma, { storeId });

    const staleSummary = await prisma.dailySalesSummary.findUnique({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId,
          stockItemId: orphanStockItem.id,
          summaryDate: staleSummaryDate,
        },
      },
    });

    expect(staleSummary).toBeNull();
  });

  it('Real MySQL: Decision Engine uses fulfilledAt last-sale semantics and does not cross tenant boundary', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const storeBFulfilledToday = new Date('2026-09-25T03:00:00.000Z');
    const storeAFulfilledEarlier = new Date('2026-09-20T03:00:00.000Z');

    const productA = await prisma.product.create({
      data: {
        storeId,
        name: `DE Store A Product ${suffix}`,
        code: `DE_A_PRD_${suffix}`,
      },
    });

    const stockItemA = await prisma.stockItem.create({
      data: {
        storeId,
        productId: productA.id,
        sku: `SKU-DE-A-${suffix}`,
        name: `DE Store A StockItem ${suffix}`,
        costPrice: 50000,
        sellingPrice: 100000,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        storeId,
        warehouseId,
        stockItemId: stockItemA.id,
        quantity: 10,
      },
    });

    const draftOrderA = await orderService.createDraftOrder(storeId, userId, {
      items: [{ stockItemId: stockItemA.id, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(storeId, userId, draftOrderA.id);
    const fulfilledOrderA = await orderService.fulfillOrder(storeId, draftOrderA.id);
    await prisma.order.update({
      where: { id: fulfilledOrderA.id },
      data: { fulfilledAt: storeAFulfilledEarlier },
    });

    const storeB = await prisma.store.create({
      data: {
        name: `DE Store B ${suffix}`,
        code: `DE_STORE_B_${suffix}`,
      },
    });
    const warehouseB = await prisma.warehouse.create({
      data: {
        storeId: storeB.id,
        name: 'DE Store B Warehouse',
        isDefault: true,
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `de_store_b_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'DE Store B User',
        role: 'SHOP_OWNER',
        storeId: storeB.id,
      },
    });
    const productB = await prisma.product.create({
      data: {
        storeId: storeB.id,
        name: `DE Store B Product ${suffix}`,
        code: `DE_B_PRD_${suffix}`,
      },
    });
    const stockItemB = await prisma.stockItem.create({
      data: {
        storeId: storeB.id,
        productId: productB.id,
        sku: `SKU-DE-B-${suffix}`,
        name: `DE Store B StockItem ${suffix}`,
        costPrice: 50000,
        sellingPrice: 100000,
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        storeId: storeB.id,
        warehouseId: warehouseB.id,
        stockItemId: stockItemB.id,
        quantity: 10,
      },
    });

    const orderServiceB = new OrderService(prisma);
    const draftOrderB = await orderServiceB.createDraftOrder(storeB.id, userB.id, {
      items: [{ stockItemId: stockItemB.id, quantity: 1 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderServiceB.confirmOrder(storeB.id, userB.id, draftOrderB.id);
    const fulfilledOrderB = await orderServiceB.fulfillOrder(storeB.id, draftOrderB.id);
    await prisma.order.update({
      where: { id: fulfilledOrderB.id },
      data: { fulfilledAt: storeBFulfilledToday },
    });

    const analysis = await decisionEngineService.analyzeSku(storeId, stockItemA.id, {
      persist: false,
      evaluationDate: new Date('2026-09-25T04:00:00.000Z'),
    });

    expect(analysis.risk.daysSinceLastSale).toBe(5);
    expect(analysis.confidence.level).toBe('LOW');

    await prisma.store.delete({ where: { id: storeB.id } }).catch(() => {});
  });
});
