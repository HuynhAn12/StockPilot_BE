import { DailySalesSummaryAggregateRow } from '../daily-sales-summary/daily-sales-summary.service';

export interface SafetyStockResult {
  safetyStock: number;
  method: 'STATISTICAL' | 'FALLBACK_SAFETY_DAYS' | 'INSUFFICIENT_DATA';
  zScore: number;
}

/** Minimum expected units in the recent window before a z-test on daily counts is meaningful. */
export const MIN_EXPECTED_UNITS_FOR_ANOMALY = 5;

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |relative error| < 1.15e-9).
 * Deterministic and monotonic, replacing the former step table that mapped 0.85 above 0.90.
 */
export function inverseStandardNormal(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError('Probability must be in (0, 1)');
  }

  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface RiskEvaluationResult {
  stockoutScore: number;
  stockoutSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  overstockScore: number;
  overstockSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  isSlowMoving: boolean;
  isDeadStock: boolean;
  deadStockSeverity: 'NONE' | 'WARNING' | 'CRITICAL';
  daysSinceLastSale: number | null;
  deadStockCostValue: number;
  deadStockRetailValue: number;
  confidence: {
    score: number;
    level: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  unusualDemand: {
    isAnomaly: boolean;
    type: 'NONE' | 'CRITICAL_SPIKE' | 'HIGH_SPIKE' | 'DEMAND_DROP' | 'NEW_DEMAND_SPIKE';
    zScore: number;
  };
}

export class RiskEvaluator {
  /** z = Φ⁻¹(serviceLevel), rounded to 3 decimals (0.90 -> 1.282, 0.95 -> 1.645, 0.99 -> 2.326). */
  public static getZScoreForServiceLevel(serviceLevel: number): number {
    const bounded = Math.min(0.9999, Math.max(0.5, serviceLevel));
    return Number(inverseStandardNormal(bounded).toFixed(3));
  }

  /**
   * Calculates Safety Stock.
   */
  calculateSafetyStock(params: {
    stdDev30: number;
    leadTimeDays: number;
    serviceLevel: number;
    avg30: number;
    safetyDays: number;
    hasSufficientHistory: boolean;
  }): SafetyStockResult {
    const { stdDev30, leadTimeDays, serviceLevel, avg30, safetyDays, hasSufficientHistory } = params;
    const zScore = RiskEvaluator.getZScoreForServiceLevel(serviceLevel);

    if (hasSufficientHistory && stdDev30 > 0) {
      const calculated = Math.ceil(zScore * stdDev30 * Math.sqrt(Math.max(1, leadTimeDays)));
      return {
        safetyStock: Math.max(0, calculated),
        method: 'STATISTICAL',
        zScore,
      };
    }

    const fallback = Math.ceil(avg30 * Math.max(1, safetyDays));
    return {
      safetyStock: Math.max(0, fallback),
      method: 'FALLBACK_SAFETY_DAYS',
      zScore,
    };
  }

  /**
   * Calculates Reorder Point (ROP = ceil((ADD_30 * LeadTime) + SafetyStock)).
   */
  calculateReorderPoint(avg30: number, leadTimeDays: number, safetyStock: number): number {
    return Math.ceil(avg30 * Math.max(1, leadTimeDays) + safetyStock);
  }

  /**
   * Order-up-to replenishment quantity, only when available stock is at or below the reorder point:
   *   Q = max(0, ceil(μ · (L + targetCoverageDays) + SS − available)), capped at maxStock − available.
   * Without sufficient history μ is unreliable, so the fact-based fallback refills to maxStock
   * (or minStock when no max is configured). Assumes no open purchase orders (none are modelled).
   */
  calculateReorderQuantity(params: {
    availableStock: number;
    reorderPoint: number;
    avgDailyDemand: number;
    leadTimeDays: number;
    targetCoverageDays: number;
    safetyStock: number;
    minStockLevel: number;
    maxStockLevel: number;
    hasSufficientHistory: boolean;
  }): number {
    const { availableStock, reorderPoint, avgDailyDemand, leadTimeDays, targetCoverageDays, safetyStock, minStockLevel, maxStockLevel, hasSufficientHistory } = params;
    if (availableStock > reorderPoint) {
      return 0;
    }

    const cap = maxStockLevel > 0 ? Math.max(0, maxStockLevel - availableStock) : Number.POSITIVE_INFINITY;
    if (!hasSufficientHistory) {
      const target = maxStockLevel > 0 ? maxStockLevel : minStockLevel;
      return Math.max(0, target - availableStock);
    }

    const targetLevel = avgDailyDemand * (Math.max(1, leadTimeDays) + targetCoverageDays) + safetyStock;
    return Math.min(cap, Math.max(0, Math.ceil(targetLevel - availableStock)));
  }

  /**
   * Calculates Days of Inventory Coverage (DaysOfCover = AvailableStock / ADD_30).
   */
  calculateDaysOfCover(availableStock: number, avg30: number): number | null {
    if (avg30 <= 0) return null;
    return Number((availableStock / avg30).toFixed(1));
  }

  /**
   * Calculates deterministic Decision Confidence based on history depth and quality.
   */
  calculateConfidence(historyDays: number, minimumHistoryDays: number, daysWithSales: number): {
    score: number;
    level: 'LOW' | 'MEDIUM' | 'HIGH';
  } {
    const coverage = Math.min(1.0, Math.max(0, historyDays / Math.max(1, minimumHistoryDays)));
    let rawScore = Math.round(coverage * 80);
    if (daysWithSales >= 5) {
      rawScore += 20;
    } else {
      rawScore += daysWithSales * 4;
    }
    const score = Math.min(100, Math.max(0, rawScore));

    let level: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    if (score >= 75) level = 'HIGH';
    else if (score >= 40) level = 'MEDIUM';

    return { score, level };
  }

  /**
   * Calculates Stockout Risk (0 - 100).
   */
  calculateStockoutRisk(params: {
    availableStock: number;
    reorderPoint: number;
    daysOfCover: number | null;
    leadTimeDays: number;
    safetyDays: number;
    trendRatio: number;
    lowThreshold: number;
    highThreshold: number;
    criticalThreshold: number;
  }): { score: number; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } {
    const { availableStock, reorderPoint, daysOfCover, leadTimeDays, safetyDays, trendRatio, highThreshold, criticalThreshold, lowThreshold } = params;

    if (availableStock <= 0) {
      return { score: 100, severity: 'CRITICAL' };
    }

    const shortageRatio = Math.max(0, reorderPoint - availableStock) / Math.max(reorderPoint, 1);
    const requiredCoverage = Math.max(1, leadTimeDays + safetyDays);
    const coverageRisk = daysOfCover !== null ? Math.max(0, 1 - daysOfCover / requiredCoverage) : (shortageRatio > 0 ? 0.7 : 0);
    const trendRisk = Math.min(Math.max((trendRatio - 1.0) / 1.0, 0), 1);

    let weightedScore = Math.round(100 * (0.5 * shortageRatio + 0.35 * coverageRisk + 0.15 * trendRisk));
    if (availableStock <= reorderPoint && reorderPoint > 0) {
      const minStockoutScore = shortageRatio >= 0.7 ? criticalThreshold : shortageRatio >= 0.3 ? highThreshold : lowThreshold;
      weightedScore = Math.max(weightedScore, minStockoutScore);
    }
    const score = Math.min(100, Math.max(0, weightedScore));

    let severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (score >= criticalThreshold) severity = 'CRITICAL';
    else if (score >= highThreshold) severity = 'HIGH';
    else if (score >= lowThreshold) severity = 'MEDIUM';

    return { score, severity };
  }

  /**
   * Calculates Overstock Risk (0 - 100).
   */
  calculateOverstockRisk(params: {
    availableStock: number;
    maxStockLevel: number;
    daysOfCover: number | null;
    targetCoverageDays: number;
    trendRatio: number;
    lowThreshold: number;
    highThreshold: number;
    criticalThreshold: number;
  }): { score: number; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } {
    const { availableStock, maxStockLevel, daysOfCover, targetCoverageDays, trendRatio, lowThreshold, highThreshold, criticalThreshold } = params;

    const qtyExcessRatio = Math.max(0, availableStock - maxStockLevel) / Math.max(maxStockLevel, 1);
    const coverageExcess =
      daysOfCover !== null
        ? Math.max(0, daysOfCover - targetCoverageDays) / Math.max(targetCoverageDays, 1)
        : (qtyExcessRatio > 0 ? 0.5 : 0);
    const declineRisk = Math.min(Math.max(1.0 - trendRatio, 0), 1);

    const weighted = 0.45 * Math.min(1, qtyExcessRatio) + 0.4 * Math.min(1, coverageExcess) + 0.15 * declineRisk;
    let score = Math.min(100, Math.max(0, Math.round(100 * weighted)));
    if (availableStock > maxStockLevel && maxStockLevel > 0) {
      const minOverstockScore = qtyExcessRatio >= 0.5 ? highThreshold : lowThreshold;
      score = Math.max(score, minOverstockScore);
    }

    let severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (score >= criticalThreshold) severity = 'CRITICAL';
    else if (score >= highThreshold) severity = 'HIGH';
    else if (score >= lowThreshold) severity = 'MEDIUM';

    return { score, severity };
  }

  /**
   * Evaluates Slow Moving and Dead Stock status.
   * `daysSinceLastSale` is the number of days without a sale: since the last sale, or since the SKU was
   * first stocked when it never sold. Critical dead stock starts at twice the dead-stock threshold
   * (default 90 -> 180 days, as in docs/next-steps.md).
   */
  evaluateSlowAndDeadStock(params: {
    availableStock: number;
    daysSinceLastSale: number | null;
    slowMovingDays: number;
    deadStockDays: number;
    costPrice: number;
    sellingPrice: number;
  }): {
    isSlowMoving: boolean;
    isDeadStock: boolean;
    severity: 'NONE' | 'WARNING' | 'CRITICAL';
    costValue: number;
    retailValue: number;
  } {
    const { availableStock, daysSinceLastSale, slowMovingDays, deadStockDays, costPrice, sellingPrice } = params;

    if (availableStock <= 0 || daysSinceLastSale === null) {
      return {
        isSlowMoving: false,
        isDeadStock: false,
        severity: 'NONE',
        costValue: 0,
        retailValue: 0,
      };
    }

    const isSlowMoving = daysSinceLastSale >= slowMovingDays;
    const isDeadStock = daysSinceLastSale >= deadStockDays;

    let severity: 'NONE' | 'WARNING' | 'CRITICAL' = 'NONE';
    if (daysSinceLastSale >= deadStockDays * 2) {
      severity = 'CRITICAL';
    } else if (isDeadStock || isSlowMoving) {
      severity = 'WARNING';
    }

    const costValue = Number((availableStock * costPrice).toFixed(2));
    const retailValue = Number((availableStock * sellingPrice).toFixed(2));

    return {
      isSlowMoving,
      isDeadStock,
      severity,
      costValue,
      retailValue,
    };
  }

  /**
   * Detects unusual demand spikes or drops of the recent window against a disjoint baseline.
   *
   * The statistic compares a mean of n recent days with the baseline, so its standard error is σ/√n:
   *   z = (x̄_recent − μ_baseline) / (σ_baseline / √n).
   * The baseline must not contain the recent days (the caller passes a disjoint window). For sparse
   * count data (expected units in the window < MIN_EXPECTED_UNITS_FOR_ANOMALY) the normal
   * approximation is invalid, so only a "new demand" pattern is reported.
   */
  detectUnusualDemand(
    recent3Series: DailySalesSummaryAggregateRow[],
    mean30: number,
    stdDev30: number
  ): {
    isAnomaly: boolean;
    type: 'NONE' | 'CRITICAL_SPIKE' | 'HIGH_SPIKE' | 'DEMAND_DROP' | 'NEW_DEMAND_SPIKE';
    zScore: number;
  } {
    const n = recent3Series.length;
    const recentQty = recent3Series.reduce((acc, r) => acc + r.netSoldQty, 0);
    const recentAvg = n > 0 ? recentQty / n : 0;

    if (n === 0) {
      return { isAnomaly: false, type: 'NONE', zScore: 0 };
    }

    if (mean30 * n < MIN_EXPECTED_UNITS_FOR_ANOMALY || stdDev30 <= 0.05) {
      if (mean30 <= 0.05 && recentQty >= 3) {
        return { isAnomaly: true, type: 'NEW_DEMAND_SPIKE', zScore: 3.5 };
      }
      return { isAnomaly: false, type: 'NONE', zScore: 0 };
    }

    const zScore = Number(((recentAvg - mean30) / (stdDev30 / Math.sqrt(n))).toFixed(2));

    if (zScore >= 3.0) {
      return { isAnomaly: true, type: 'CRITICAL_SPIKE', zScore };
    }
    if (zScore >= 2.0) {
      return { isAnomaly: true, type: 'HIGH_SPIKE', zScore };
    }
    if (zScore <= -2.0) {
      return { isAnomaly: true, type: 'DEMAND_DROP', zScore };
    }

    return { isAnomaly: false, type: 'NONE', zScore };
  }
}
