import { DailySalesSummaryAggregateRow } from '../daily-sales-summary/daily-sales-summary.service';

export interface SafetyStockResult {
  safetyStock: number;
  method: 'STATISTICAL' | 'FALLBACK_SAFETY_DAYS';
  zScore: number;
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
  public static getZScoreForServiceLevel(serviceLevel: number): number {
    if (serviceLevel >= 0.99) return 2.326;
    if (serviceLevel >= 0.975) return 1.96;
    if (serviceLevel >= 0.95) return 1.645;
    if (serviceLevel >= 0.9) return 1.282;
    return 1.645; // Default 95%
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
    const coverageRisk = daysOfCover !== null ? Math.max(0, 1 - daysOfCover / requiredCoverage) : 0;
    const trendRisk = Math.min(Math.max((trendRatio - 1.0) / 1.0, 0), 1);

    const weightedScore = Math.round(100 * (0.5 * shortageRatio + 0.35 * coverageRisk + 0.15 * trendRisk));
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
        : 0;
    const declineRisk = Math.min(Math.max(1.0 - trendRatio, 0), 1);

    const weighted = 0.45 * Math.min(1, qtyExcessRatio) + 0.4 * Math.min(1, coverageExcess) + 0.15 * declineRisk;
    const score = Math.min(100, Math.max(0, Math.round(100 * weighted)));

    let severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (score >= criticalThreshold) severity = 'CRITICAL';
    else if (score >= highThreshold) severity = 'HIGH';
    else if (score >= lowThreshold) severity = 'MEDIUM';

    return { score, severity };
  }

  /**
   * Evaluates Slow Moving and Dead Stock status.
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
    if (daysSinceLastSale >= 180) {
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
   * Detects unusual demand spikes or drops based on recent 3 days vs 30 days history.
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
    const recentQty = recent3Series.reduce((acc, r) => acc + r.netSoldQty, 0);
    const recentAvg = recent3Series.length > 0 ? recentQty / recent3Series.length : 0;

    if (stdDev30 <= 0.05) {
      if (mean30 <= 0.05 && recentAvg > 0) {
        return { isAnomaly: true, type: 'NEW_DEMAND_SPIKE', zScore: 3.5 };
      }
      return { isAnomaly: false, type: 'NONE', zScore: 0 };
    }

    const zScore = Number(((recentAvg - mean30) / stdDev30).toFixed(2));

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
