import fs from 'fs';
import path from 'path';
import { DailySalesSummaryAggregateRow } from '../../src/modules/daily-sales-summary/daily-sales-summary.service';
import { OVERSTOCK_PRICING_COVER_MULTIPLE, PricingEvaluator } from '../../src/modules/decision-engine/pricing-evaluator';
import { EngineConfigService } from '../../src/modules/decision-engine/engine-config.service';
import {
  compareOverviewPriority,
  DecisionEngineService,
  SkuDecisionAnalysisResult,
} from '../../src/modules/decision-engine/decision-engine.service';
import { DecisionEngineController } from '../../src/modules/decision-engine/decision-engine.controller';
import { DecisionJobsService } from '../../src/modules/decision-engine/decision-jobs.service';
import { toEngineConfigView, toOverviewSummaryView } from '../../src/modules/decision-engine/decision-view';
import { DECISION_ENGINE_VERSION, DEFAULT_ENGINE_CONFIG } from '../../src/modules/decision-engine/engine-defaults';
import { BusinessSyncService } from '../../src/common/services/business-sync.service';
import { ValidationError } from '../../src/common/errors/app-error';

const pricingEvaluator = new PricingEvaluator();

function makeAnalysis(
  stockItemId: number,
  opts: { available?: number; stockout?: number; overstock?: number; deadStock?: boolean } = {}
): SkuDecisionAnalysisResult {
  const { available = 10, stockout = 0, overstock = 0, deadStock = false } = opts;
  return {
    stockItemId,
    sku: `SKU-${stockItemId}`,
    productName: `Item ${stockItemId}`,
    categoryName: null,
    inventory: { onHand: available, reserved: 0, available, minStockLevel: 0, maxStockLevel: 0 },
    dataStatus: 'OK',
    historyDays: 90,
    demand: {
      avg7: 1, avg30: 1, avg60: 1, avg90: 1, stdDev30: 0, variance30: 0,
      trendRatio: 1, trend: 'STABLE', totalSold90: 90, daysWithSales90: 90,
    },
    coverage: { safetyStock: 0, safetyStockMethod: 'STATISTICAL', reorderPoint: 0, reorderQuantity: 0, daysOfCover: available },
    risk: {
      stockout,
      stockoutSeverity: 'LOW',
      overstock,
      overstockSeverity: 'LOW',
      slowMoving: deadStock,
      deadStock,
      deadStockSeverity: deadStock ? 'WARNING' : 'NONE',
      daysSinceLastSale: 1,
      daysWithoutSale: 1,
      deadStockCostValue: deadStock ? 1000 : 0,
      deadStockRetailValue: deadStock ? 2000 : 0,
      unusualDemand: { isAnomaly: false, type: 'NONE', zScore: 0 },
    },
    confidence: { score: 100, level: 'HIGH' },
    pricing: { costPrice: 1000, sellingPrice: 2000, minimumPrice: 2000, expectedMarginPct: 50 },
    pricingEvaluation: {
      action: 'MAINTAIN', currentPrice: 2000, recommendedPrice: 2000, discountPct: 0,
      minimumPrice: 2000, expectedMarginPct: 50, confidence: 100, factors: [], shouldGenerateRecommendation: false,
    },
    engineConfig: { ...DEFAULT_ENGINE_CONFIG },
    engineVersion: DECISION_ENGINE_VERSION,
    factors: [],
    calculatedAt: '2026-11-02T00:00:00.000Z',
  };
}

/** Overview harness: no SKU has a snapshot, so every SKU goes through the (spied) live evaluation. */
function overviewHarness(ids: number[], analyze: (id: number) => Promise<SkuDecisionAnalysisResult>) {
  const prisma = {
    stockItem: { findMany: jest.fn().mockResolvedValue(ids.map((id) => ({ id, updatedAt: new Date() }))) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    decisionSnapshot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { groupBy: jest.fn().mockResolvedValue([]) },
    engineConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const service = new DecisionEngineService(prisma as any);
  const analyzeSpy = jest
    .spyOn(service, 'analyzeSku')
    .mockImplementation(async (_storeId: number, id: number) => analyze(id));
  return { service, prisma, analyzeSpy };
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('MỤC 1 - pricing thresholds follow EngineConfig', () => {
  const base = {
    sellingPrice: 100000,
    costPrice: 50000,
    minimumMarginPct: 0.2,
    maxMarkdownPct: 0.3,
    maxMarkupPct: 0.2,
    daysSinceLastSale: 1,
    daysOfCover: 10,
    overstockScore: 0,
    stockoutScore: 0,
    trend: 'STABLE' as const,
    confidenceScore: 80,
    availableStock: 10,
  };

  it('keeps the default-config markdown behaviour (overstock 50, cover > 45)', () => {
    expect(OVERSTOCK_PRICING_COVER_MULTIPLE).toBe(1.5);
    expect(pricingEvaluator.evaluatePricing({ ...base, overstockScore: 50 }).action).toBe('DECREASE');
    expect(pricingEvaluator.evaluatePricing({ ...base, overstockScore: 49 }).action).toBe('MAINTAIN');
    expect(pricingEvaluator.evaluatePricing({ ...base, daysOfCover: 46 }).action).toBe('DECREASE');
    expect(pricingEvaluator.evaluatePricing({ ...base, daysOfCover: 45 }).action).toBe('MAINTAIN');
  });

  it('uses highRiskThreshold for the overstock markdown trigger', () => {
    expect(pricingEvaluator.evaluatePricing({ ...base, overstockScore: 60, highRiskThreshold: 70 }).action).toBe('MAINTAIN');
    expect(pricingEvaluator.evaluatePricing({ ...base, overstockScore: 70, highRiskThreshold: 70 }).action).toBe('DECREASE');
  });

  it('uses targetCoverageDays for the days-of-cover markdown trigger', () => {
    expect(pricingEvaluator.evaluatePricing({ ...base, daysOfCover: 50, targetCoverageDays: 60 }).action).toBe('MAINTAIN');
    expect(pricingEvaluator.evaluatePricing({ ...base, daysOfCover: 100, targetCoverageDays: 60 }).action).toBe('DECREASE');
  });

  it('uses highRiskThreshold for the stockout markup trigger', () => {
    const scarce = { ...base, stockoutScore: 55, trend: 'UP' as const };
    expect(pricingEvaluator.evaluatePricing({ ...scarce, highRiskThreshold: 50 }).action).toBe('INCREASE');
    expect(pricingEvaluator.evaluatePricing({ ...scarce, highRiskThreshold: 60 }).action).toBe('MAINTAIN');
  });

  it('bumps the engine version because default pricing output changed', () => {
    expect(DECISION_ENGINE_VERSION).toBe('DECISION_ENGINE_V2.2');
  });

  it('passes the store thresholds from EngineConfig into the pricing evaluation', async () => {
    const zeros: DailySalesSummaryAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
      summaryDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      grossSoldQty: 0, returnQty: 0, netSoldQty: 0, grossRevenue: 0, refundAmount: 0,
      netRevenue: 0, cogs: 0, grossProfit: 0, orderCount: 0,
    }));
    const db = {
      stockItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1, storeId: 1, sku: 'SKU', name: 'Item', costPrice: 1000, sellingPrice: 2000,
          minStockLevel: 0, maxStockLevel: 0, product: { category: null }, balances: [],
        }),
      },
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      historicalSale: { findFirst: jest.fn().mockResolvedValue(null) },
      stockMovement: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const evaluator = new PricingEvaluator();
    const spy = jest.spyOn(evaluator, 'evaluatePricing');
    const engine = new DecisionEngineService(
      db as any,
      { getDailySeries: jest.fn().mockResolvedValue(zeros) } as any,
      { getConfig: jest.fn().mockResolvedValue({ ...DEFAULT_ENGINE_CONFIG, highRiskThreshold: 65, targetCoverageDays: 40 }) } as any,
      undefined,
      undefined,
      evaluator
    );

    await engine.analyzeSku(1, 1, { persist: false });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ highRiskThreshold: 65, targetCoverageDays: 40 }));
  });
});

describe('MỤC 2 - overview ordering, bounded live evaluation, no silent drops', () => {
  it('orders out-of-stock first, then by highest risk, dead stock, and id', () => {
    const items = [
      makeAnalysis(1, { stockout: 10 }),
      makeAnalysis(2, { overstock: 80 }),
      makeAnalysis(3, { available: 0, stockout: 100 }),
      makeAnalysis(4, { stockout: 80 }),
      makeAnalysis(5, { deadStock: true, overstock: 10 }),
      makeAnalysis(6, { stockout: 10 }),
    ];
    expect([...items].sort(compareOverviewPriority).map((a) => a.stockItemId)).toEqual([3, 2, 4, 5, 1, 6]);
  });

  it('paginates the sorted list deterministically', async () => {
    const risks: Record<number, number> = { 1: 5, 2: 90, 3: 40, 4: 90, 5: 70, 6: 0 };
    const { service } = overviewHarness([1, 2, 3, 4, 5, 6], async (id) => makeAnalysis(id, { stockout: risks[id] }));

    const page1 = await service.getOverview(1, { riskFilter: 'ALL', page: 1, limit: 3 });
    const page2 = await service.getOverview(1, { riskFilter: 'ALL', page: 2, limit: 3 });
    expect([...page1.items, ...page2.items].map((i) => i.analysis.stockItemId)).toEqual([2, 4, 5, 3, 1, 6]);
  });

  it('evaluates at most maxLiveSkus SKUs live and reports the rest as pending', async () => {
    const { service, analyzeSpy } = overviewHarness([1, 2, 3, 4, 5, 6, 7], async (id) => makeAnalysis(id));

    const result = await service.getOverview(1, { riskFilter: 'ALL', page: 1, limit: 50 }, { maxLiveSkus: 3 });
    expect(analyzeSpy.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
    expect(result.summary).toMatchObject({ totalSkus: 3, pendingSkuCount: 4, failedSkuCount: 0 });
    expect(result.pendingStockItemIds).toEqual([4, 5, 6, 7]);
  });

  it('runs live evaluations with a concurrency of at most 5', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const { service } = overviewHarness(ids, async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return makeAnalysis(id);
    });

    const result = await service.getOverview(1, { riskFilter: 'ALL', page: 1, limit: 50 }, { maxLiveSkus: 12 });
    expect(result.summary.totalSkus).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('counts failed live evaluations instead of dropping them silently', async () => {
    const { service } = overviewHarness([1, 2, 3], async (id) => {
      if (id === 2) throw new Error('boom');
      return makeAnalysis(id);
    });

    const result = await service.getOverview(1, { riskFilter: 'ALL', page: 1, limit: 50 });
    expect(result.summary).toMatchObject({ totalSkus: 2, failedSkuCount: 1, pendingSkuCount: 0 });
    expect(result.items.map((i) => i.analysis.stockItemId)).toEqual([1, 3]);
  });

  it('controller hands pending SKUs to the Trigger layer and keeps them out of the response', async () => {
    const service = {
      getOverview: jest.fn().mockResolvedValue({
        items: [{ analysis: makeAnalysis(1, { deadStock: true }), freshness: { stale: true, snapshotAt: null, source: 'LIVE' } }],
        summary: {
          totalSkus: 1, stockoutRiskCount: 0, overstockRiskCount: 0, deadStockCount: 1,
          totalDeadStockCostValue: 1000, totalDeadStockRetailValue: 2000, pendingSkuCount: 2, failedSkuCount: 1,
        },
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        pendingStockItemIds: [4, 5],
      }),
    };
    const jobs = { enqueueRecompute: jest.fn(), onEngineConfigChanged: jest.fn() };
    const controller = new DecisionEngineController(service as any, {} as any, jobs as any);
    const res = mockRes();
    const next = jest.fn();

    await controller.getOverview({ user: { storeId: 7, role: 'WAREHOUSE_STAFF' }, query: {} } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(jobs.enqueueRecompute).toHaveBeenCalledWith(7, [4, 5]);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('pendingStockItemIds');
    expect(body.summary).toMatchObject({ pendingSkuCount: 2, failedSkuCount: 1 });
    expect(body.summary).not.toHaveProperty('totalDeadStockCostValue');
  });

  it('staff summary view keeps the new counters and hides cost', () => {
    const view = toOverviewSummaryView(
      {
        totalSkus: 1, stockoutRiskCount: 0, overstockRiskCount: 0, deadStockCount: 0,
        totalDeadStockCostValue: 10, totalDeadStockRetailValue: 20, pendingSkuCount: 3, failedSkuCount: 4,
      },
      'WAREHOUSE_STAFF'
    );
    expect(view).toMatchObject({ pendingSkuCount: 3, failedSkuCount: 4 });
    expect(view).not.toHaveProperty('totalDeadStockCostValue');
  });

  it('Decision Engine and EngineConfig never import the Trigger layer', () => {
    const dir = path.join(__dirname, '../../src/modules/decision-engine');
    const lowerLayers = [
      'decision-engine.service.ts',
      'engine-config.service.ts',
      'engine-defaults.ts',
      'pricing-evaluator.ts',
      'risk-evaluator.ts',
      'risk-classification.ts',
      'demand-metrics.service.ts',
      'decision-view.ts',
    ];
    const violations = lowerLayers.flatMap((file) =>
      fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split(/\r?\n/)
        .filter((line) => /\bfrom\s+['"][^'"]*(business-sync|recompute-queue|decision-jobs|decision-scheduler)/.test(line))
        .map((line) => `${file}: ${line.trim()}`)
    );
    expect(violations).toEqual([]);
  });
});

describe('MỤC 3 - config changes trigger a recompute through the Trigger layer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('onEngineConfigChanged enqueues every active SKU of the store', async () => {
    const prisma = { stockItem: { findMany: jest.fn().mockResolvedValue([{ id: 3 }, { id: 8 }]) } };
    const sync = { syncStockItems: jest.fn().mockResolvedValue(undefined) };
    const fireAndForget = jest
      .spyOn(BusinessSyncService, 'fireAndForget')
      .mockImplementation((_prisma, trigger) => void trigger(sync as any));
    const jobs = new DecisionJobsService(prisma as any, {} as any, {} as any, {} as any);

    await jobs.onEngineConfigChanged(5);

    expect(prisma.stockItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: 5, isActive: true } })
    );
    expect(fireAndForget).toHaveBeenCalledTimes(1);
    expect(sync.syncStockItems).toHaveBeenCalledWith(5, [3, 8]);
  });

  it('onEngineConfigChanged never throws', async () => {
    const prisma = { stockItem: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } };
    const jobs = new DecisionJobsService(prisma as any, {} as any, {} as any, {} as any);
    await expect(jobs.onEngineConfigChanged(5)).resolves.toBeUndefined();
  });

  it('enqueueRecompute skips empty lists and never throws', () => {
    const fireAndForget = jest.spyOn(BusinessSyncService, 'fireAndForget').mockImplementation(() => {
      throw new Error('queue broken');
    });
    const jobs = new DecisionJobsService({} as any, {} as any, {} as any, {} as any);
    expect(() => jobs.enqueueRecompute(1, [])).not.toThrow();
    expect(fireAndForget).not.toHaveBeenCalled();
    expect(() => jobs.enqueueRecompute(1, [1])).not.toThrow();
  });

  it('controller triggers the recompute after a valid update only', async () => {
    const configService = { upsertConfig: jest.fn().mockResolvedValue({ ...DEFAULT_ENGINE_CONFIG, source: 'CUSTOM' }) };
    const jobs = { enqueueRecompute: jest.fn(), onEngineConfigChanged: jest.fn().mockResolvedValue(undefined) };
    const controller = new DecisionEngineController({} as any, configService as any, jobs as any);

    const res = mockRes();
    const next = jest.fn();
    await controller.updateConfig({ user: { storeId: 9, role: 'SHOP_OWNER' }, body: { leadTimeDays: 5 } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(jobs.onEngineConfigChanged).toHaveBeenCalledWith(9);

    jobs.onEngineConfigChanged.mockClear();
    configService.upsertConfig.mockRejectedValueOnce(new ValidationError('Cấu hình Decision Engine không hợp lệ'));
    const next2 = jest.fn();
    await controller.updateConfig({ user: { storeId: 9, role: 'SHOP_OWNER' }, body: { lowRiskThreshold: 90 } } as any, mockRes(), next2);
    expect(next2).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(jobs.onEngineConfigChanged).not.toHaveBeenCalled();
  });

  it('a failing enqueue does not fail the request', async () => {
    const configService = { upsertConfig: jest.fn().mockResolvedValue({ ...DEFAULT_ENGINE_CONFIG, source: 'CUSTOM' }) };
    const jobs = { enqueueRecompute: jest.fn(), onEngineConfigChanged: jest.fn().mockRejectedValue(new Error('queue broken')) };
    const controller = new DecisionEngineController({} as any, configService as any, jobs as any);
    const res = mockRes();
    const next = jest.fn();

    await controller.updateConfig({ user: { storeId: 9, role: 'SHOP_OWNER' }, body: { leadTimeDays: 5 } } as any, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('MỤC 4 - snapshots record the config version', () => {
  it('getConfig reports DEFAULT or the ISO time of the stored config', async () => {
    const updatedAt = new Date('2026-10-30T08:15:00.000Z');
    const findUnique = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...DEFAULT_ENGINE_CONFIG,
      serviceLevel: 0.95,
      minimumMarginPct: 0.2,
      maxMarkdownPct: 0.3,
      maxMarkupPct: 0.2,
      updatedAt,
    });
    const service = new EngineConfigService({ engineConfig: { findUnique } } as any);

    expect((await service.getConfig(1)).configVersion).toBe('DEFAULT');
    expect((await service.getConfig(1)).configVersion).toBe(updatedAt.toISOString());
  });

  it('upsertConfig returns the version of the saved row', async () => {
    const updatedAt = new Date('2026-11-01T01:00:00.000Z');
    const prisma = {
      engineConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ ...DEFAULT_ENGINE_CONFIG, leadTimeDays: 5, updatedAt }),
      },
    };
    const service = new EngineConfigService(prisma as any);
    expect((await service.upsertConfig(1, { leadTimeDays: 5 })).configVersion).toBe(updatedAt.toISOString());
  });

  it('writes configVersion into the snapshot and reads it back', () => {
    const analysis = makeAnalysis(1);
    analysis.engineConfig = { ...analysis.engineConfig, configVersion: '2026-10-30T08:15:00.000Z', source: 'CUSTOM' };
    const payload = DecisionEngineService.toSnapshotPayload(analysis);
    expect((payload.inputJson as any).config.configVersion).toBe('2026-10-30T08:15:00.000Z');

    const restored = DecisionEngineService.fromSnapshot({
      id: 1, storeId: 1, stockItemId: 1, calculatedAt: new Date(), version: DECISION_ENGINE_VERSION, ...payload,
    } as any);
    expect(restored?.engineConfig.configVersion).toBe('2026-10-30T08:15:00.000Z');
  });

  it('reads an older snapshot without configVersion as UNKNOWN', () => {
    const payload = DecisionEngineService.toSnapshotPayload(makeAnalysis(1));
    delete (payload.inputJson as any).config.configVersion;

    const restored = DecisionEngineService.fromSnapshot({
      id: 1, storeId: 1, stockItemId: 1, calculatedAt: new Date(), version: 'DECISION_ENGINE_V2.1', ...payload,
    } as any);
    expect(restored).not.toBeNull();
    expect(restored!.engineConfig.configVersion).toBe('UNKNOWN');
  });

  it('staff config view includes configVersion', () => {
    const view = toEngineConfigView({ ...DEFAULT_ENGINE_CONFIG, configVersion: 'X' }, 'WAREHOUSE_STAFF');
    expect(view).toMatchObject({ configVersion: 'X' });
    expect(view).not.toHaveProperty('minimumMarginPct');
  });
});
