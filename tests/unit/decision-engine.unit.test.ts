import { DemandService } from '../../src/modules/decision-engine/demand.service';
import { RiskService } from '../../src/modules/decision-engine/risk.service';
import { DailyMetricAggregateRow } from '../../src/modules/daily-metrics/daily-metrics.service';

describe('Decision Engine Unit Tests', () => {
  const demandService = new DemandService();
  const riskService = new RiskService();

  describe('DemandService', () => {
    test('calculates correct ADD_N and StdDev for standard steady sales', () => {
      // Create 90 days where every day has 3 sales
      const series90: DailyMetricAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        metricDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: 3,
        returnedQty: 0,
        netSoldQty: 3,
        grossRevenue: 300000,
        refundAmount: 0,
        netRevenue: 300000,
        orderCount: 1,
      }));

      const result = demandService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(3);
      expect(result.avg30).toBe(3);
      expect(result.avg60).toBe(3);
      expect(result.avg90).toBe(3);
      expect(result.stdDev30).toBe(0);
      expect(result.trendRatio).toBe(1.0);
      expect(result.trend).toBe('STABLE');
    });

    test('handles zero sales properly without division by zero', () => {
      const series90: DailyMetricAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        metricDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: 0,
        returnedQty: 0,
        netSoldQty: 0,
        grossRevenue: 0,
        refundAmount: 0,
        netRevenue: 0,
        orderCount: 0,
      }));

      const result = demandService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(0);
      expect(result.avg30).toBe(0);
      expect(result.stdDev30).toBe(0);
      expect(result.trend).toBe('STABLE_ZERO');
    });

    test('detects demand spike and trends (UP, STRONG_UP, DOWN)', () => {
      // 83 days of 2/day, then last 7 days of 10/day
      const series90: DailyMetricAggregateRow[] = Array.from({ length: 90 }, (_, i) => ({
        metricDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        grossSoldQty: i >= 83 ? 10 : 2,
        returnedQty: 0,
        netSoldQty: i >= 83 ? 10 : 2,
        grossRevenue: 100000,
        refundAmount: 0,
        netRevenue: 100000,
        orderCount: 1,
      }));

      const result = demandService.calculateDemandMetrics(series90);
      expect(result.avg7).toBe(10);
      expect(result.avg30).toBeGreaterThan(2);
      expect(result.trendRatio).toBeGreaterThan(1.5);
      expect(result.trend).toBe('STRONG_UP');
    });
  });

  describe('RiskService', () => {
    test('calculates Statistical Safety Stock and Fallback Safety Stock correctly', () => {
      // Statistical: Z(0.95)=1.645, stdDev=2, leadTime=9 => ceil(1.645 * 2 * sqrt(9)) = ceil(1.645 * 2 * 3) = ceil(9.87) = 10
      const statResult = riskService.calculateSafetyStock({
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
      const fallbackResult = riskService.calculateSafetyStock({
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
      // ADD_30 = 3, LeadTime = 5, SafetyStock = 7 => 3*5 + 7 = 22
      const rop = riskService.calculateReorderPoint(3, 5, 7);
      expect(rop).toBe(22);
    });

    test('calculates Days Of Inventory (DOI)', () => {
      expect(riskService.calculateDaysOfInventory(30, 3)).toBe(10);
      expect(riskService.calculateDaysOfInventory(30, 0)).toBeNull();
    });

    test('evaluates Stockout Risk score and severity', () => {
      // Case 1: Available = 0 => 100, CRITICAL
      const zeroStock = riskService.calculateStockoutRisk({
        availableStock: 0,
        reorderPoint: 20,
        daysOfInventory: null,
        leadTimeDays: 7,
        safetyDays: 3,
        trendRatio: 1.0,
      });
      expect(zeroStock.score).toBe(100);
      expect(zeroStock.severity).toBe('CRITICAL');

      // Case 2: Available = 5, ROP = 20 => high shortage
      const lowStock = riskService.calculateStockoutRisk({
        availableStock: 5,
        reorderPoint: 20,
        daysOfInventory: 2,
        leadTimeDays: 7,
        safetyDays: 3,
        trendRatio: 1.2,
      });
      expect(lowStock.score).toBeGreaterThanOrEqual(50);
    });

    test('evaluates Dead Stock and capital valuation', () => {
      const deadStock = riskService.evaluateDeadStock({
        availableStock: 50,
        daysSinceLastSale: 120,
        configuredDeadStockDays: 90,
        costPrice: 100000,
        sellingPrice: 150000,
      });

      expect(deadStock.isDeadStock).toBe(true);
      expect(deadStock.severity).toBe('WARNING');
      expect(deadStock.costValue).toBe(5000000);
      expect(deadStock.retailValue).toBe(7500000);

      const criticalDeadStock = riskService.evaluateDeadStock({
        availableStock: 50,
        daysSinceLastSale: 200,
        configuredDeadStockDays: 90,
        costPrice: 100000,
        sellingPrice: 150000,
      });
      expect(criticalDeadStock.severity).toBe('CRITICAL');
    });

    test('detects unusual demand anomalies using Z-score', () => {
      const recentSpike: DailyMetricAggregateRow[] = [
        { metricDate: '2026-03-01', grossSoldQty: 20, returnedQty: 0, netSoldQty: 20, grossRevenue: 0, refundAmount: 0, netRevenue: 0, orderCount: 1 },
        { metricDate: '2026-03-02', grossSoldQty: 25, returnedQty: 0, netSoldQty: 25, grossRevenue: 0, refundAmount: 0, netRevenue: 0, orderCount: 1 },
        { metricDate: '2026-03-03', grossSoldQty: 30, returnedQty: 0, netSoldQty: 30, grossRevenue: 0, refundAmount: 0, netRevenue: 0, orderCount: 1 },
      ];

      const anomaly = riskService.detectUnusualDemand(recentSpike, 5, 2);
      expect(anomaly.isAnomaly).toBe(true);
      expect(anomaly.type).toBe('CRITICAL_SPIKE');
      expect(anomaly.zScore).toBeGreaterThanOrEqual(3.0);
    });
  });
});
