import { DemandMetricsService } from '../../src/modules/decision-engine/demand-metrics.service';
import { RiskEvaluator } from '../../src/modules/decision-engine/risk-evaluator';
import { PricingEvaluator } from '../../src/modules/decision-engine/pricing-evaluator';
import { DailySalesSummaryAggregateRow } from '../../src/modules/daily-sales-summary/daily-sales-summary.service';

describe('Decision Engine Unit Tests', () => {
  const demandMetricsService = new DemandMetricsService();
  const riskEvaluator = new RiskEvaluator();
  const pricingEvaluator = new PricingEvaluator();

  describe('DemandMetricsService', () => {
    test('calculates correct ADD_N, StdDev, and variance for steady sales', () => {
      const series90: DailySalesSummaryAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        summaryDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: 3,
        returnQty: 0,
        netSoldQty: 3,
        grossRevenue: 300000,
        refundAmount: 0,
        netRevenue: 300000,
        cogs: 150000,
        grossProfit: 150000,
        orderCount: 1,
      }));

      const result = demandMetricsService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(3);
      expect(result.avg30).toBe(3);
      expect(result.avg60).toBe(3);
      expect(result.avg90).toBe(3);
      expect(result.stdDev30).toBe(0);
      expect(result.variance30).toBe(0);
      expect(result.trendRatio).toBe(1.0);
      expect(result.trend).toBe('STABLE');
      expect(result.totalSold90).toBe(270);
      expect(result.daysWithSales90).toBe(90);
    });

    test('handles zero sales without division by zero', () => {
      const series90: DailySalesSummaryAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        summaryDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: 0,
        returnQty: 0,
        netSoldQty: 0,
        grossRevenue: 0,
        refundAmount: 0,
        netRevenue: 0,
        cogs: 0,
        grossProfit: 0,
        orderCount: 0,
      }));

      const result = demandMetricsService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(0);
      expect(result.avg30).toBe(0);
      expect(result.stdDev30).toBe(0);
      expect(result.trend).toBe('STABLE_ZERO');
      expect(result.daysWithSales90).toBe(0);
    });

    test('detects demand spike and trend classifications', () => {
      // 83 days of 2/day, then last 7 days of 10/day
      const series90: DailySalesSummaryAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        summaryDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: i >= 83 ? 10 : 2,
        returnQty: 0,
        netSoldQty: i >= 83 ? 10 : 2,
        grossRevenue: 100000,
        refundAmount: 0,
        netRevenue: 100000,
        cogs: 50000,
        grossProfit: 50000,
        orderCount: 1,
      }));

      const result = demandMetricsService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(10);
      expect(result.avg30).toBeGreaterThan(2);
      expect(result.trendRatio).toBeGreaterThanOrEqual(1.5);
      expect(result.trend).toBe('STRONG_UP');
    });
  });

  describe('RiskEvaluator', () => {
    test('calculates Statistical Safety Stock and Fallback Safety Stock correctly', () => {
      // Statistical: Z(0.95)=1.645, stdDev=2, leadTime=9 => ceil(1.645 * 2 * sqrt(9)) = ceil(9.87) = 10
      const statResult = riskEvaluator.calculateSafetyStock({
        stdDev30: 2,
        leadTimeDays: 9,
        serviceLevel: 0.95,
        avg30: 5,
        safetyDays: 3,
        hasSufficientHistory: true,
      });

      expect(statResult.method).toBe('STATISTICAL');
      expect(statResult.safetyStock).toBe(10);

      // Fallback: avg30=5, safetyDays=3 => ceil(5 * 3) = 15
      const fallbackResult = riskEvaluator.calculateSafetyStock({
        stdDev30: 0,
        leadTimeDays: 9,
        serviceLevel: 0.95,
        avg30: 5,
        safetyDays: 3,
        hasSufficientHistory: false,
      });

      expect(fallbackResult.method).toBe('FALLBACK_SAFETY_DAYS');
      expect(fallbackResult.safetyStock).toBe(15);
    });

    test('calculates Reorder Point (ROP = ceil(ADD_30 * LeadTime + SafetyStock))', () => {
      const rop = riskEvaluator.calculateReorderPoint(3, 5, 7);
      expect(rop).toBe(22);
    });

    test('calculates Days of Cover (coverage days)', () => {
      expect(riskEvaluator.calculateDaysOfCover(30, 3)).toBe(10);
      expect(riskEvaluator.calculateDaysOfCover(30, 0)).toBeNull();
    });

    test('calculates deterministic Confidence score', () => {
      const highConf = riskEvaluator.calculateConfidence(90, 14, 20);
      expect(highConf.score).toBe(100);
      expect(highConf.level).toBe('HIGH');

      const lowConf = riskEvaluator.calculateConfidence(3, 14, 1);
      expect(lowConf.score).toBeLessThan(40);
      expect(lowConf.level).toBe('LOW');
    });

    test('evaluates Stockout Risk score and severity', () => {
      const zeroStock = riskEvaluator.calculateStockoutRisk({
        availableStock: 0,
        reorderPoint: 20,
        daysOfCover: null,
        leadTimeDays: 7,
        safetyDays: 3,
        trendRatio: 1.0,
        lowThreshold: 25,
        highThreshold: 50,
        criticalThreshold: 75,
      });
      expect(zeroStock.score).toBe(100);
      expect(zeroStock.severity).toBe('CRITICAL');

      const lowStock = riskEvaluator.calculateStockoutRisk({
        availableStock: 5,
        reorderPoint: 20,
        daysOfCover: 2,
        leadTimeDays: 7,
        safetyDays: 3,
        trendRatio: 1.2,
        lowThreshold: 25,
        highThreshold: 50,
        criticalThreshold: 75,
      });
      expect(lowStock.score).toBeGreaterThanOrEqual(50);
    });

    test('evaluates Slow-Moving, Dead Stock, and capital valuation', () => {
      const deadStock = riskEvaluator.evaluateSlowAndDeadStock({
        availableStock: 50,
        daysSinceLastSale: 120,
        slowMovingDays: 60,
        deadStockDays: 90,
        costPrice: 100000,
        sellingPrice: 150000,
      });

      expect(deadStock.isSlowMoving).toBe(true);
      expect(deadStock.isDeadStock).toBe(true);
      expect(deadStock.severity).toBe('WARNING');
      expect(deadStock.costValue).toBe(5000000);
      expect(deadStock.retailValue).toBe(7500000);

      const criticalDeadStock = riskEvaluator.evaluateSlowAndDeadStock({
        availableStock: 50,
        daysSinceLastSale: 200,
        slowMovingDays: 60,
        deadStockDays: 90,
        costPrice: 100000,
        sellingPrice: 150000,
      });
      expect(criticalDeadStock.severity).toBe('CRITICAL');
    });

    test('detects unusual demand anomalies using Z-score', () => {
      const recentSpike: DailySalesSummaryAggregateRow[] = [
        { summaryDate: '2026-03-01', grossSoldQty: 20, returnQty: 0, netSoldQty: 20, grossRevenue: 0, refundAmount: 0, netRevenue: 0, cogs: 0, grossProfit: 0, orderCount: 1 },
        { summaryDate: '2026-03-02', grossSoldQty: 25, returnQty: 0, netSoldQty: 25, grossRevenue: 0, refundAmount: 0, netRevenue: 0, cogs: 0, grossProfit: 0, orderCount: 1 },
        { summaryDate: '2026-03-03', grossSoldQty: 30, returnQty: 0, netSoldQty: 30, grossRevenue: 0, refundAmount: 0, netRevenue: 0, cogs: 0, grossProfit: 0, orderCount: 1 },
      ];

      const anomaly = riskEvaluator.detectUnusualDemand(recentSpike, 5, 2);
      expect(anomaly.isAnomaly).toBe(true);
      expect(anomaly.type).toBe('CRITICAL_SPIKE');
      expect(anomaly.zScore).toBeGreaterThanOrEqual(3.0);
    });
  });

  describe('PricingEvaluator', () => {
    test('calculates minimum allowed price using gross margin floor: cost / (1 - marginPct)', () => {
      // cost = 100,000, margin = 20% => minimumPrice = 100000 / 0.8 = 125,000
      const minPrice = PricingEvaluator.calculateMinimumPrice(100000, 0.20);
      expect(minPrice).toBe(125000);
    });

    test('evaluates DECREASE recommendation on Dead Stock while respecting minimum margin floor', () => {
      const result = pricingEvaluator.evaluatePricing({
        sellingPrice: 200000,
        costPrice: 100000,
        minimumMarginPct: 0.20,
        maxMarkdownPct: 0.30,
        maxMarkupPct: 0.20,
        daysSinceLastSale: 100, // dead stock warning => 15% markdown
        daysOfCover: 80,
        overstockScore: 60,
        stockoutScore: 0,
        trend: 'DOWN', // +3% markdown => total 18%
        confidenceScore: 80,
      });

      expect(result.action).toBe('DECREASE');
      expect(result.shouldGenerateRecommendation).toBe(true);
      expect(result.recommendedPrice).toBeLessThan(200000);
      expect(result.recommendedPrice).toBeGreaterThanOrEqual(125000); // >= minimumPrice
    });

    test('evaluates INCREASE recommendation on High Stockout Risk + Strong Demand Trend', () => {
      const result = pricingEvaluator.evaluatePricing({
        sellingPrice: 150000,
        costPrice: 100000,
        minimumMarginPct: 0.20,
        maxMarkdownPct: 0.30,
        maxMarkupPct: 0.20,
        daysSinceLastSale: 1,
        daysOfCover: 3,
        overstockScore: 0,
        stockoutScore: 80,
        trend: 'STRONG_UP',
        confidenceScore: 90,
      });

      expect(result.action).toBe('INCREASE');
      expect(result.shouldGenerateRecommendation).toBe(true);
      expect(result.recommendedPrice).toBeGreaterThan(150000);
    });

    test('evaluates MAINTAIN when confidence is low (< 40)', () => {
      const result = pricingEvaluator.evaluatePricing({
        sellingPrice: 150000,
        costPrice: 100000,
        minimumMarginPct: 0.20,
        maxMarkdownPct: 0.30,
        maxMarkupPct: 0.20,
        daysSinceLastSale: 120,
        daysOfCover: 90,
        overstockScore: 80,
        stockoutScore: 0,
        trend: 'DOWN',
        confidenceScore: 30, // Low confidence
      });

      expect(result.action).toBe('MAINTAIN');
      expect(result.shouldGenerateRecommendation).toBe(false);
      expect(result.recommendedPrice).toBe(150000);
    });
  });
});
