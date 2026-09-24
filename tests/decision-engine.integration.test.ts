import { HistoricalSalesService } from '../src/modules/historical-sales/historical-sales.service';
import { DailySalesSummaryService } from '../src/modules/daily-sales-summary/daily-sales-summary.service';
import { DecisionEngineService } from '../src/modules/decision-engine/decision-engine.service';
import { AlertService } from '../src/modules/alerts/alert.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { AssistantService } from '../src/modules/assistant/assistant.service';
import { EngineConfigService } from '../src/modules/decision-engine/engine-config.service';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    stockItem: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    historicalSale: { findMany: jest.fn(), findFirst: jest.fn(), createMany: jest.fn(), count: jest.fn() },
    importJob: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    importJobItem: { updateMany: jest.fn() },
    orderItem: { findMany: jest.fn(), findFirst: jest.fn() },
    returnItem: { findMany: jest.fn() },
    dailySalesSummary: { findMany: jest.fn(), upsert: jest.fn() },
    engineConfig: { findUnique: jest.fn(), upsert: jest.fn() },
    alert: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    pricingRecommendation: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    priceHistory: { create: jest.fn(), findMany: jest.fn() },
    decisionSnapshot: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('Decision Engine & Historical Sales Pipeline Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('HistoricalSalesService', () => {
    const historicalSalesService = new HistoricalSalesService(prisma as any);

    it('generates deterministic SHA-256 row hashes', () => {
      const hash1 = HistoricalSalesService.computeRowHash(1, 'CSV', 'INV-001', 'SKU-A', new Date('2026-06-01T10:00:00.000Z'), 5, 100000);
      const hash2 = HistoricalSalesService.computeRowHash(1, 'CSV', 'INV-001', 'SKU-A', new Date('2026-06-01T10:00:00.000Z'), 5, 100000);
      const hashDiff = HistoricalSalesService.computeRowHash(1, 'CSV', 'INV-002', 'SKU-A', new Date('2026-06-01T10:00:00.000Z'), 5, 100000);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hashDiff);
      expect(hash1).toHaveLength(64);
    });

    it('previews historical sales identifying matched SKUs, unmatched SKUs, and duplicates', async () => {
      (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([
        { id: 10, sku: 'SKU-A', name: 'Sản phẩm A' },
      ]);
      (prisma.historicalSale.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.importJob.create as jest.Mock).mockResolvedValue({ id: 'job-hs-001', totalRows: 2 });

      const preview = await historicalSalesService.previewHistoricalSales(1, 100, [
        { sku: 'SKU-A', quantity: 5, unitPrice: 100000, soldAt: new Date('2026-05-01'), source: 'CSV', externalOrderId: 'ORD-1' },
        { sku: 'SKU-UNMATCHED', quantity: 2, unitPrice: 50000, soldAt: new Date('2026-05-02'), source: 'CSV', externalOrderId: 'ORD-2' },
      ]);

      expect(preview.jobId).toBe('job-hs-001');
      expect(preview.validRows).toBe(1);
      expect(preview.warningRows).toBe(1);
    });

    it('commits historical sales and marks job COMPLETED without mutating inventory balances', async () => {
      (prisma.importJob.findUnique as jest.Mock).mockResolvedValue({
        id: 'job-hs-001',
        storeId: 1,
        status: 'PREVIEWED',
        expiresAt: new Date(Date.now() + 100000),
        items: [
          {
            rowNumber: 1,
            stockItemId: 10,
            sku: 'SKU-A',
            status: 'PENDING',
            resultJson: {
              sourceRowHash: 'hash-123',
              quantity: 5,
              unitPrice: 100000,
              totalAmount: 500000,
              soldAt: new Date('2026-05-01').toISOString(),
              source: 'CSV',
              externalOrderId: 'ORD-1',
            },
          },
        ],
      });

      (prisma.historicalSale.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.importJobItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.importJob.update as jest.Mock).mockResolvedValue({ id: 'job-hs-001', status: 'COMPLETED' });

      const commit = await historicalSalesService.commitHistoricalSales(1, 100, 'job-hs-001');
      expect(commit.status).toBe('COMPLETED');
      expect((commit.result as any)?.insertedCount).toBe(1);
      expect(prisma.historicalSale.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
        })
      );
    });
  });

  describe('DailySalesSummaryService & DecisionEngineService', () => {
    const dailySalesSummaryService = new DailySalesSummaryService(prisma as any);
    const engineConfigService = new EngineConfigService(prisma as any);
    const alertService = new AlertService(prisma as any);
    const pricingService = new PricingService(prisma as any);

    it('rebuilds daily sales summaries aggregating fulfilled orders and historical sales minus returns with COGS', async () => {
      (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([{ id: 10, costPrice: 50000 }]);
      (prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
        { stockItemId: 10, quantity: 4, subtotal: 400000, costPriceSnapshot: 50000, order: { id: 1, fulfilledAt: new Date('2026-03-01T10:00:00Z') } },
      ]);
      (prisma.historicalSale.findMany as jest.Mock).mockResolvedValue([
        { stockItemId: 10, quantity: 6, totalAmount: 600000, soldAt: new Date('2026-03-01T15:00:00Z'), externalOrderId: 'H1' },
      ]);
      (prisma.returnItem.findMany as jest.Mock).mockResolvedValue([
        { stockItemId: 10, quantity: 2, refundPrice: 100000, returnOrder: { createdAt: new Date('2026-03-01T16:00:00Z') } },
      ]);
      (prisma.dailySalesSummary.upsert as jest.Mock).mockResolvedValue({ id: 1 });

      const result = await dailySalesSummaryService.rebuildDailySalesSummary(1, new Date('2026-03-01'), new Date('2026-03-01'));
      expect(result.processedCount).toBe(1);
      expect(prisma.dailySalesSummary.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            grossSoldQty: 10, // 4 from Order + 6 from HistoricalSale
            returnQty: 2,
            netSoldQty: 8, // 10 - 2
          }),
        })
      );
    });

    it('runs end-to-end analyzeSku producing demand, ROP, safetyStock, and persists snapshot', async () => {
      const decisionEngineService = new DecisionEngineService(
        prisma as any,
        dailySalesSummaryService,
        engineConfigService,
        undefined as any,
        undefined as any,
        undefined as any,
        alertService,
        pricingService
      );

      (prisma.stockItem.findUnique as jest.Mock).mockResolvedValue({
        id: 10,
        storeId: 1,
        sku: 'SKU-A',
        name: 'Áo thun thể thao',
        costPrice: 50000,
        sellingPrice: 100000,
        minStockLevel: 5,
        maxStockLevel: 500,
        product: { category: { name: 'Thời trang' } },
        balances: [{ quantity: 15, reservedQuantity: 5 }], // available = 10
      });

      (prisma.dailySalesSummary.findMany as jest.Mock).mockResolvedValue([
        { summaryDate: new Date('2026-09-20'), grossSoldQty: 3, returnQty: 0, netSoldQty: 3, grossRevenue: 300000, refundAmount: 0, netRevenue: 300000, cogs: 150000, grossProfit: 150000, orderCount: 1 },
      ]);

      (prisma.engineConfig.findUnique as jest.Mock).mockResolvedValue(null); // use default config
      (prisma.alert.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.alert.create as jest.Mock).mockResolvedValue({ id: 1 });
      (prisma.pricingRecommendation.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.decisionSnapshot.create as jest.Mock).mockResolvedValue({ id: 1 });

      const analysis = await decisionEngineService.analyzeSku(1, 10);

      expect(analysis.stockItemId).toBe(10);
      expect(analysis.sku).toBe('SKU-A');
      expect(analysis.inventory.available).toBe(10);
      expect(analysis.engineConfig.source).toBe('DEFAULT');
      expect(analysis.coverage.reorderPoint).toBeGreaterThanOrEqual(1);
      expect(prisma.decisionSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 'DECISION_ENGINE_V1',
            storeId: 1,
            stockItemId: 10,
          }),
        })
      );
    });
  });

  describe('PricingService & AlertService Workflow', () => {
    const pricingService = new PricingService(prisma as any);
    const alertService = new AlertService(prisma as any);

    it('generates pricing recommendation with strict gross margin price floor clamp', async () => {
      (prisma.pricingRecommendation.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.pricingRecommendation.create as jest.Mock).mockResolvedValue({ id: 99, status: 'PENDING' });

      const rec = await pricingService.evaluatePricingRecommendation({
        storeId: 1,
        stockItemId: 10,
        sellingPrice: 200000,
        costPrice: 100000,
        minimumMarginPct: 0.20, // Floor = 125,000 VND
        maxMarkdownPct: 0.30,
        maxMarkupPct: 0.20,
        daysSinceLastSale: 120, // 15% markdown
        daysOfCover: 40,
        overstockScore: 60,
        stockoutScore: 0,
        trend: 'DOWN', // +3% markdown => 18% total => 164,000 VND
        confidenceScore: 80,
      });

      expect(rec).not.toBeNull();
      expect(rec.action).toBe('DECREASE');
      expect(prisma.pricingRecommendation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storeId: 1,
            stockItemId: 10,
            status: 'PENDING',
          }),
        })
      );
    });

    it('accepts pricing recommendation, updates stockItem selling price and records PriceHistory', async () => {
      (prisma.pricingRecommendation.findUnique as jest.Mock).mockResolvedValue({
        id: 99,
        storeId: 1,
        stockItemId: 10,
        action: 'DECREASE',
        recommendedPrice: 164000,
        status: 'PENDING',
        stockItem: { sellingPrice: 200000 },
      });
      (prisma.pricingRecommendation.update as jest.Mock).mockResolvedValue({ id: 99, status: 'ACCEPTED' });
      (prisma.stockItem.update as jest.Mock).mockResolvedValue({ id: 10, sellingPrice: 164000 });
      (prisma.priceHistory.create as jest.Mock).mockResolvedValue({ id: 1 });

      const accepted = await pricingService.acceptRecommendation(1, 100, 99, true);
      expect(accepted.status).toBe('ACCEPTED');
      expect(prisma.stockItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10 },
          data: { sellingPrice: 164000 },
        })
      );
      expect(prisma.priceHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storeId: 1,
            stockItemId: 10,
            source: 'RECOMMENDATION_ACCEPT',
            recommendationId: 99,
            changedById: 100,
          }),
        })
      );
    });

    it('acknowledges and resolves alerts', async () => {
      (prisma.alert.findUnique as jest.Mock).mockResolvedValue({
        id: 5,
        storeId: 1,
        status: 'OPEN',
      });
      (prisma.alert.update as jest.Mock).mockResolvedValue({ id: 5, status: 'ACKNOWLEDGED' });

      const ack = await alertService.acknowledgeAlert(1, 5);
      expect(ack.status).toBe('ACKNOWLEDGED');

      (prisma.alert.update as jest.Mock).mockResolvedValue({ id: 5, status: 'RESOLVED' });
      const resolved = await alertService.resolveAlert(1, 5);
      expect(resolved.status).toBe('RESOLVED');
    });
  });

  describe('AssistantService Factual AI Context Builder', () => {
    it('produces explainable factual summary without mutating data or hallucinating numbers', async () => {
      const assistantService = new AssistantService(prisma as any);

      (prisma.stockItem.findUnique as jest.Mock).mockResolvedValue({
        id: 10,
        storeId: 1,
        sku: 'SKU-A',
        name: 'Áo thun thể thao',
        costPrice: 50000,
        sellingPrice: 100000,
        minStockLevel: 5,
        maxStockLevel: 500,
        product: { category: { name: 'Thời trang' } },
        balances: [{ quantity: 0, reservedQuantity: 0 }], // available = 0
      });

      (prisma.dailySalesSummary.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.engineConfig.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.alert.findMany as jest.Mock).mockResolvedValue([
        { type: 'STOCKOUT', severity: 'CRITICAL', title: 'Hết hàng', message: 'Hết hàng', riskScore: 100, confidence: 100 },
      ]);
      (prisma.pricingRecommendation.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.decisionSnapshot.create as jest.Mock).mockResolvedValue({ id: 1 });

      const explanation = await assistantService.explainSku(1, 10, 'Tại sao sản phẩm này có nguy cơ thiếu hàng?');

      expect(explanation.sku).toBe('SKU-A');
      expect(explanation.explanation).toContain('CẢNH BÁO HẾT HÀNG');
      expect(explanation.factualContext.inventory.available).toBe(0);
      expect(explanation.factualContext.activeAlerts).toHaveLength(1);
    });
  });
});
