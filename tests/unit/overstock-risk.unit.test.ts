import { RiskEvaluator } from '../../src/modules/decision-engine/risk-evaluator';
import { describeOverstock } from '../../src/modules/alerts/alert.service';

const evaluator = new RiskEvaluator();
const thresholds = { lowThreshold: 25, highThreshold: 50, criticalThreshold: 75 };

/** daysOfCover is derived from demand the way the engine does: available / avg daily demand. */
function overstock(params: {
  availableStock: number;
  maxStockLevel?: number;
  avgDailyDemand?: number;
  trendRatio?: number;
  replenishmentLevel?: number;
  targetCoverageDays?: number;
}) {
  const demand = params.avgDailyDemand ?? 0;
  return evaluator.calculateOverstockRisk({
    availableStock: params.availableStock,
    maxStockLevel: params.maxStockLevel ?? 0,
    daysOfCover: demand > 0 ? Number((params.availableStock / demand).toFixed(1)) : null,
    targetCoverageDays: params.targetCoverageDays ?? 30,
    trendRatio: params.trendRatio ?? 1,
    replenishmentLevel: params.replenishmentLevel ?? 0,
    ...thresholds,
  });
}

describe('RiskEvaluator.calculateOverstockRisk (V2.1)', () => {
  it('no longer gives every slow seller below its max level the same 55', () => {
    // The production case: stock under the max level, slow sales, nothing sold in the last 7 days.
    const scores = [90, 220, 900].map((days) => overstock({ availableStock: 22, maxStockLevel: 50, avgDailyDemand: 22 / days, trendRatio: 0 }).score);

    expect(new Set(scores).size).toBe(3);
    expect(scores[0]).toBeLessThan(scores[1]);
    expect(scores[1]).toBeLessThan(scores[2]);
  });

  it('scores excess coverage on a graded curve: 2x target is low, 3x is the high threshold', () => {
    expect(overstock({ availableStock: 60, avgDailyDemand: 1 }).score).toBe(33);
    expect(overstock({ availableStock: 90, avgDailyDemand: 1 }).score).toBe(50);
    expect(overstock({ availableStock: 30, avgDailyDemand: 1 }).score).toBe(0);
  });

  it('explains the score with its drivers and the units beyond the target cover', () => {
    const result = overstock({ availableStock: 22, maxStockLevel: 50, avgDailyDemand: 0.1, trendRatio: 0 });

    expect(result.score).toBe(76);
    expect(result.severity).toBe('CRITICAL');
    expect(result.detail).toMatchObject({
      drivers: ['EXCESS_COVERAGE'],
      unitsAboveMax: 0,
      daysOfCover: 220,
      coverageMultiple: 7.3,
      unitsBeyondTargetCover: 19,
    });
  });

  it('ignores a stalled trend for low-volume SKUs, where a quiet week is ordinary noise', () => {
    const lowVolume = overstock({ availableStock: 12, avgDailyDemand: 0.1, trendRatio: 0 });
    const highVolume = overstock({ availableStock: 120, avgDailyDemand: 1, trendRatio: 0.2 });

    expect(lowVolume.detail.drivers).not.toContain('FALLING_DEMAND');
    expect(lowVolume.score).toBe(60);
    expect(highVolume.detail.drivers).toEqual(['EXCESS_COVERAGE', 'FALLING_DEMAND']);
    expect(highVolume.score).toBe(72);
  });

  it('never counts stock at or below the replenishment level as excess coverage', () => {
    const result = overstock({ availableStock: 10, avgDailyDemand: 0.05, replenishmentLevel: 10 });
    expect(result.score).toBe(0);
    expect(result.detail.drivers).toEqual([]);
  });

  it('leaves SKUs without known demand to the slow-moving and dead-stock rules', () => {
    const result = overstock({ availableStock: 22, maxStockLevel: 50 });
    expect(result.score).toBe(0);
    expect(result.detail.coverageMultiple).toBeNull();
  });

  it('keeps the business floor for stock above the owner’s max level, even without history', () => {
    expect(overstock({ availableStock: 60, maxStockLevel: 50 }).score).toBe(29);
    expect(overstock({ availableStock: 80, maxStockLevel: 50 }).score).toBe(55);
    expect(overstock({ availableStock: 100, maxStockLevel: 50 }).score).toBe(67);
    expect(overstock({ availableStock: 100, maxStockLevel: 50 }).detail).toMatchObject({ drivers: ['ABOVE_MAX_LEVEL'], unitsAboveMax: 50 });
  });

  it('combines both kinds of excess without exceeding 100', () => {
    const both = overstock({ availableStock: 500, maxStockLevel: 50, avgDailyDemand: 1, trendRatio: 0 });
    const capOnly = overstock({ availableStock: 500, maxStockLevel: 50 });

    expect(both.score).toBeGreaterThan(capOnly.score);
    expect(both.score).toBeLessThanOrEqual(100);
  });

  it('is monotonic in days of cover', () => {
    let previous = -1;
    for (let days = 10; days <= 2000; days += 10) {
      const { score } = overstock({ availableStock: 100, avgDailyDemand: 100 / days });
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });
});

describe('describeOverstock', () => {
  it('names the real cause instead of claiming the safety threshold was exceeded', () => {
    const { detail } = overstock({ availableStock: 22, maxStockLevel: 50, avgDailyDemand: 0.1 });

    expect(describeOverstock('AP-AK01', 22, detail)).toBe(
      'Sản phẩm AP-AK01: đủ bán khoảng 220 ngày, gấp 7.3 lần mục tiêu 30 ngày (dư khoảng 19 đơn vị).'
    );
  });

  it('reports units above the max level and falling demand', () => {
    const { detail } = overstock({ availableStock: 120, maxStockLevel: 60, avgDailyDemand: 1, trendRatio: 0.2 });
    const message = describeOverstock('SKU-1', 120, detail);

    expect(message).toContain('vượt mức tối đa 60 (dư 60)');
    expect(message).toContain('chỉ bằng 20% trung bình 30 ngày');
  });

  it('falls back to the generic text for alerts recorded before V2.1', () => {
    expect(describeOverstock('SKU-1', 5)).toContain('vượt ngưỡng an toàn');
  });
});
