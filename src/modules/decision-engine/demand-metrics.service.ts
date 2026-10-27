import { DailySalesSummaryAggregateRow } from '../daily-sales-summary/daily-sales-summary.service';

export type DemandTrend =
  | 'STRONG_UP'
  | 'UP'
  | 'STABLE'
  | 'DOWN'
  | 'STRONG_DOWN'
  | 'NEW_DEMAND_SPIKE'
  | 'STABLE_ZERO';

export interface DemandMetricsResult {
  avg7: number;
  avg30: number;
  avg60: number;
  avg90: number;
  stdDev30: number;
  variance30: number;
  trendRatio: number;
  trend: DemandTrend;
  totalSold90: number;
  daysWithSales90: number;
}

export class DemandMetricsService {
  /**
   * Calculates deterministic demand metrics from a 90-day daily sales summary series.
   * Assumes series is sorted chronologically ascending with exactly 90 days.
   *
   * `historyDays` (H) is how many trailing days the SKU was actually exposed to demand. Windows are
   * truncated to min(window, H) so a SKU listed 15 days ago is not averaged over 30 zero-padded days
   * (which biases μ downwards). σ is the sample standard deviation (Bessel, n − 1).
   * Omitting historyDays keeps the full series length.
   */
  calculateDemandMetrics(series90: DailySalesSummaryAggregateRow[], historyDays?: number): DemandMetricsResult {
    if (historyDays !== undefined) {
      const exposed = Math.max(0, Math.min(series90.length, Math.floor(historyDays)));
      series90 = exposed > 0 ? series90.slice(series90.length - exposed) : [];
    }
    const totalDays = series90.length;
    if (totalDays === 0) {
      return {
        avg7: 0,
        avg30: 0,
        avg60: 0,
        avg90: 0,
        stdDev30: 0,
        variance30: 0,
        trendRatio: 1.0,
        trend: 'STABLE_ZERO',
        totalSold90: 0,
        daysWithSales90: 0,
      };
    }

    const series7 = series90.slice(Math.max(0, totalDays - 7));
    const series30 = series90.slice(Math.max(0, totalDays - 30));
    const series60 = series90.slice(Math.max(0, totalDays - 60));

    const sumQty = (arr: DailySalesSummaryAggregateRow[]) =>
      arr.reduce((acc, row) => acc + row.netSoldQty, 0);

    const totalSold7 = sumQty(series7);
    const totalSold30 = sumQty(series30);
    const totalSold60 = sumQty(series60);
    const totalSold90 = sumQty(series90);

    const avg7 = Number((totalSold7 / Math.max(series7.length, 1)).toFixed(2));
    const avg30 = Number((totalSold30 / Math.max(series30.length, 1)).toFixed(2));
    const avg60 = Number((totalSold60 / Math.max(series60.length, 1)).toFixed(2));
    const avg90 = Number((totalSold90 / Math.max(series90.length, 1)).toFixed(2));

    // Calculate Variance and StdDev for 30-day window (sample variance, n - 1)
    const n30 = series30.length;
    let variance30 = 0;
    if (n30 > 1) {
      const mean30 = totalSold30 / n30;
      const squaredDiffs = series30.reduce((acc, row) => {
        const diff = row.netSoldQty - mean30;
        return acc + diff * diff;
      }, 0);
      variance30 = squaredDiffs / (n30 - 1);
    }
    const stdDev30 = Number(Math.sqrt(variance30).toFixed(2));

    // Trend analysis
    let trendRatio = 1.0;
    let trend: DemandTrend = 'STABLE';

    if (avg30 === 0) {
      if (avg7 > 0) {
        trendRatio = 2.0;
        trend = 'NEW_DEMAND_SPIKE';
      } else {
        trendRatio = 1.0;
        trend = 'STABLE_ZERO';
      }
    } else {
      trendRatio = Number((avg7 / avg30).toFixed(2));
      if (trendRatio >= 1.5) {
        trend = 'STRONG_UP';
      } else if (trendRatio >= 1.15) {
        trend = 'UP';
      } else if (trendRatio >= 0.85) {
        trend = 'STABLE';
      } else if (trendRatio >= 0.5) {
        trend = 'DOWN';
      } else {
        trend = 'STRONG_DOWN';
      }
    }

    const daysWithSales90 = series90.filter((r) => r.netSoldQty > 0).length;

    return {
      avg7,
      avg30,
      avg60,
      avg90,
      stdDev30,
      variance30: Number(variance30.toFixed(2)),
      trendRatio,
      trend,
      totalSold90,
      daysWithSales90,
    };
  }
}
