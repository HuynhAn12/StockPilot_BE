import { DailySalesSummaryAggregateRow } from '../../src/modules/daily-sales-summary/daily-sales-summary.service';
import { DemandMetricsService, DemandTrend } from '../../src/modules/decision-engine/demand-metrics.service';
import { PricingEvaluator } from '../../src/modules/decision-engine/pricing-evaluator';
import { RiskEvaluator, inverseStandardNormal } from '../../src/modules/decision-engine/risk-evaluator';
import { classifyRisk } from '../../src/modules/decision-engine/risk-classification';
import { EngineConfigService } from '../../src/modules/decision-engine/engine-config.service';
import { DecisionEngineService } from '../../src/modules/decision-engine/decision-engine.service';
import { DECISION_ENGINE_VERSION, DEFAULT_ENGINE_CONFIG } from '../../src/modules/decision-engine/engine-defaults';

function series(quantities: number[]): DailySalesSummaryAggregateRow[] {
  return quantities.map((qty, index) => ({
    summaryDate: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    grossSoldQty: qty,
    returnQty: 0,
    netSoldQty: qty,
    grossRevenue: 0,
    refundAmount: 0,
    netRevenue: 0,
    cogs: 0,
    grossProfit: 0,
    orderCount: qty > 0 ? 1 : 0,
  }));
}

const pricingEvaluator = new PricingEvaluator();
const riskEvaluator = new RiskEvaluator();
const demandMetrics = new DemandMetricsService();

describe('Decision Engine V2 - statistical model', () => {
  it('maps service level to z monotonically and matches standard normal quantiles', () => {
    let previous = -Infinity;
    for (let level = 0.5; level <= 0.999; level += 0.001) {
      const z = RiskEvaluator.getZScoreForServiceLevel(level);
      expect(z).toBeGreaterThanOrEqual(previous);
      previous = z;
    }
    expect(RiskEvaluator.getZScoreForServiceLevel(0.85)).toBeLessThan(RiskEvaluator.getZScoreForServiceLevel(0.9));
    expect(inverseStandardNormal(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseStandardNormal(0.01)).toBeCloseTo(-2.326348, 5);
  });

  it('uses the sample standard deviation (n - 1)', () => {
    const result = demandMetrics.calculateDemandMetrics(series([1, 3]));
    expect(result.stdDev30).toBeCloseTo(Math.SQRT2, 2);
  });

  it('averages demand over exposed days only, not over zero-padded history', () => {
    const quantities = [...Array(75).fill(0), ...Array(15).fill(2)];
    expect(demandMetrics.calculateDemandMetrics(series(quantities)).avg30).toBe(1);
    expect(demandMetrics.calculateDemandMetrics(series(quantities), 15).avg30).toBe(2);
    expect(demandMetrics.calculateDemandMetrics(series(quantities), 0).avg30).toBe(0);
  });

  it('tests a recent mean against its standard error σ/√n and ignores sparse counts', () => {
    const recent = series([9, 9, 9]);
    // (9 - 5) / (2 / √3) = 3.46 => critical; the old (9 - 5) / 2 = 2.0 would only be "high".
    expect(riskEvaluator.detectUnusualDemand(recent, 5, 2)).toMatchObject({ type: 'CRITICAL_SPIKE', zScore: 3.46 });
    // Expected units 0.5 * 3 < 5: the normal approximation is invalid for such sparse data.
    expect(riskEvaluator.detectUnusualDemand(series([3, 2, 4]), 0.5, 0.6).isAnomaly).toBe(false);
    expect(riskEvaluator.detectUnusualDemand(series([2, 1, 1]), 0, 0).type).toBe('NEW_DEMAND_SPIKE');
  });

  it('computes an order-up-to quantity only at or below the reorder point and caps it at maxStock', () => {
    const base = {
      reorderPoint: 20,
      avgDailyDemand: 2,
      leadTimeDays: 7,
      targetCoverageDays: 30,
      safetyStock: 6,
      minStockLevel: 5,
      maxStockLevel: 0,
      hasSufficientHistory: true,
    };
    // 2 * (7 + 30) + 6 - 10 = 70
    expect(riskEvaluator.calculateReorderQuantity({ ...base, availableStock: 10 })).toBe(70);
    expect(riskEvaluator.calculateReorderQuantity({ ...base, availableStock: 21 })).toBe(0);
    expect(riskEvaluator.calculateReorderQuantity({ ...base, availableStock: 10, maxStockLevel: 50 })).toBe(40);
    // No reliable demand: refill to maxStock (fact-based).
    expect(riskEvaluator.calculateReorderQuantity({ ...base, availableStock: 3, maxStockLevel: 40, hasSufficientHistory: false })).toBe(37);
  });

  it('classifies dead stock as critical at twice the configured dead-stock threshold', () => {
    const evaluate = (days: number, deadStockDays: number) =>
      riskEvaluator.evaluateSlowAndDeadStock({
        availableStock: 10,
        daysSinceLastSale: days,
        slowMovingDays: 30,
        deadStockDays,
        costPrice: 1,
        sellingPrice: 2,
      }).severity;
    expect(evaluate(119, 60)).toBe('WARNING');
    expect(evaluate(120, 60)).toBe('CRITICAL');
    expect(evaluate(179, 90)).toBe('WARNING');
    expect(evaluate(180, 90)).toBe('CRITICAL');
  });
});

describe('Decision Engine V2 - pricing invariants', () => {
  const baseInput = {
    minimumMarginPct: 0.2,
    maxMarkdownPct: 0.3,
    maxMarkupPct: 0.2,
    daysOfCover: 60,
    stockoutScore: 0,
    confidenceScore: 80,
  };
  const trends: DemandTrend[] = ['STRONG_UP', 'UP', 'STABLE', 'DOWN', 'STRONG_DOWN'];

  it('never recommends a price below the minimum-margin floor', () => {
    for (const costPrice of [10000, 55000, 99000, 150000]) {
      for (const sellingPrice of [costPrice * 1.05, costPrice * 1.3, costPrice * 2, costPrice * 3]) {
        for (const days of [0, 45, 90, 200, 400]) {
          for (const trend of trends) {
            for (const overstockScore of [0, 60, 100]) {
              const result = pricingEvaluator.evaluatePricing({
                ...baseInput,
                sellingPrice,
                costPrice,
                daysSinceLastSale: days,
                overstockScore,
                trend,
              });
              if (result.action !== 'MAINTAIN') {
                expect(result.recommendedPrice).toBeGreaterThanOrEqual(result.minimumPrice);
              }
            }
          }
        }
      }
    }
  });

  it('never decreases the markdown as days without sale grow (other inputs fixed)', () => {
    for (const trend of trends) {
      let previousDiscount = 0;
      for (let days = 0; days <= 400; days += 5) {
        const result = pricingEvaluator.evaluatePricing({
          ...baseInput,
          sellingPrice: 300000,
          costPrice: 100000,
          daysSinceLastSale: days,
          overstockScore: 0,
          daysOfCover: 10,
          trend,
        });
        expect(result.discountPct).toBeGreaterThanOrEqual(previousDiscount);
        previousDiscount = result.discountPct;
      }
    }
  });

  it('takes slow-moving and dead-stock thresholds from config', () => {
    const atDays = (days: number, slowMovingDays: number, deadStockDays: number) =>
      pricingEvaluator.evaluatePricing({
        ...baseInput,
        sellingPrice: 300000,
        costPrice: 100000,
        daysSinceLastSale: days,
        overstockScore: 0,
        daysOfCover: 10,
        trend: 'STABLE',
        slowMovingDays,
        deadStockDays,
      });

    expect(atDays(45, 60, 90).action).toBe('MAINTAIN');
    expect(atDays(45, 30, 90).action).toBe('DECREASE');
    expect(atDays(120, 30, 60).factors.map((f) => f.code)).toContain('DEAD_STOCK_CRITICAL');
  });

  it('gates demand-based changes on INSUFFICIENT_DATA but still corrects loss-making prices', () => {
    const demandBased = pricingEvaluator.evaluatePricing({
      ...baseInput,
      sellingPrice: 300000,
      costPrice: 100000,
      daysSinceLastSale: 200,
      overstockScore: 90,
      trend: 'STRONG_DOWN',
      dataStatus: 'INSUFFICIENT_DATA',
    });
    expect(demandBased).toMatchObject({ action: 'MAINTAIN', shouldGenerateRecommendation: false });
    expect(demandBased.factors[0].code).toBe('INSUFFICIENT_DATA');

    const sellingAtLoss = pricingEvaluator.evaluatePricing({
      ...baseInput,
      sellingPrice: 90000,
      costPrice: 100000,
      daysSinceLastSale: null,
      overstockScore: 0,
      trend: 'STABLE',
      dataStatus: 'INSUFFICIENT_DATA',
    });
    expect(sellingAtLoss).toMatchObject({ action: 'INCREASE', shouldGenerateRecommendation: true });
  });

  it('is deterministic', () => {
    const input = {
      ...baseInput,
      sellingPrice: 250000,
      costPrice: 100000,
      daysSinceLastSale: 130,
      overstockScore: 70,
      trend: 'DOWN' as const,
    };
    expect(pricingEvaluator.evaluatePricing(input)).toEqual(pricingEvaluator.evaluatePricing(input));
  });
});

describe('Decision Engine V2 - shared classification, config, and windows', () => {
  it('classifies risks with the store high-risk threshold', () => {
    const base = { availableStock: 30, reorderPoint: 10, stockoutScore: 0, overstockScore: 0, isDeadStock: false, highRiskThreshold: 60 };
    expect(classifyRisk(base)).toEqual({ outOfStock: false, stockoutRisk: false, overstockRisk: false, deadStock: false });
    expect(classifyRisk({ ...base, availableStock: 10 }).stockoutRisk).toBe(true);
    expect(classifyRisk({ ...base, stockoutScore: 59 }).stockoutRisk).toBe(false);
    expect(classifyRisk({ ...base, stockoutScore: 60 }).stockoutRisk).toBe(true);
    expect(classifyRisk({ ...base, overstockScore: 60 }).overstockRisk).toBe(true);
    expect(classifyRisk({ ...base, availableStock: 0 })).toMatchObject({ outOfStock: true, stockoutRisk: true });
  });

  it('rejects inconsistent engine config', () => {
    const valid = { lowRiskThreshold: 25, highRiskThreshold: 50, criticalRiskThreshold: 75, slowMovingDays: 60, deadStockDays: 90 };
    expect(() => EngineConfigService.assertConsistent(valid)).not.toThrow();
    expect(() => EngineConfigService.assertConsistent({ ...valid, highRiskThreshold: 80 })).toThrow('Cấu hình Decision Engine không hợp lệ');
    expect(() => EngineConfigService.assertConsistent({ ...valid, slowMovingDays: 90 })).toThrow('Cấu hình Decision Engine không hợp lệ');
  });

  it('evaluates on complete days ending the day before evaluationDate', async () => {
    const getDailySeries = jest.fn().mockResolvedValue(series(Array(90).fill(0)));
    const db = {
      stockItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          storeId: 1,
          sku: 'SKU',
          name: 'Item',
          costPrice: 1000,
          sellingPrice: 2000,
          minStockLevel: 0,
          maxStockLevel: 0,
          product: { category: null },
          balances: [],
        }),
      },
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      historicalSale: { findFirst: jest.fn().mockResolvedValue(null) },
      stockMovement: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const engine = new DecisionEngineService(
      db as any,
      { getDailySeries } as any,
      { getConfig: jest.fn().mockResolvedValue({ ...DEFAULT_ENGINE_CONFIG }) } as any
    );

    const result = await engine.analyzeSku(1, 1, { persist: false, evaluationDate: new Date('2026-09-25T04:00:00.000Z') });

    expect(getDailySeries).toHaveBeenCalledWith(1, 1, 90, db, '2026-09-24');
    expect(result.engineVersion).toBe(DECISION_ENGINE_VERSION);
    expect(result.dataStatus).toBe('INSUFFICIENT_DATA');
  });
});
