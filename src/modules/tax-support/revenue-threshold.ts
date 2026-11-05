import { addBusinessDays, businessDaysInclusiveBetween } from '../../common/utils/business-date';
import type { LedgerDay } from './revenue-ledger.service';

/**
 * E-invoice revenue threshold tracker (Decree 70/2025: household businesses with yearly revenue
 * "từ 1 tỷ đồng trở lên" must use cash-register e-invoices). Pure: no I/O, same input → same output.
 *
 *   R = year-to-date net revenue;  ratio = R / T
 *   crossedOn = first day whose running total (prefix sum) reaches T
 *   forecast  = run-rate of the last FORECAST_WINDOW_DAYS days → year-end projection and cross date
 */

export type ThresholdLevel = 'NONE' | 'WATCH' | 'WARNING' | 'REACHED' | 'PRIOR_YEAR_REACHED';

export const WATCH_RATIO = 0.7;
export const WARNING_RATIO = 0.9;
export const FORECAST_WINDOW_DAYS = 90;
export const MIN_FORECAST_DAYS = 14;
/** Days after the end of the tax period (quarter) to register, per the 2026 guidance. */
export const REGISTRATION_GRACE_DAYS = 30;

export interface ThresholdInput {
  year: number;
  todayKey: string; // YYYY-MM-DD business date, inside `year`
  threshold: number;
  /** Ledger days covering at least [min(Jan 1, today − 89 days), today], ascending. */
  days: LedgerDay[];
  priorYearRevenue: number;
  /** Earliest sale the store ever recorded (live or imported), or null when there is none. */
  firstActivityKey: string | null;
}

export interface ThresholdForecast {
  sufficientData: boolean;
  windowDays: number;
  avgDailyRevenue: number | null;
  projectedYearEnd: number | null;
  projectedCrossDate: string | null;
}

export interface ThresholdResult {
  year: number;
  threshold: number;
  ytdRevenue: number;
  ratio: number;
  level: ThresholdLevel;
  breakdown: { sales: number; imported: number; returns: number };
  priorYearRevenue: number;
  crossedOn: string | null;
  registrationDeadlineHint: string | null;
  forecast: ThresholdForecast;
}

const cents = (n: number) => Math.round(n * 100);
const vnd = (c: number) => c / 100;

/** Last day of the calendar quarter containing `dateKey`. */
export function quarterEndKey(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number);
  const lastMonth = Math.ceil(m / 3) * 3;
  const lastDay = new Date(Date.UTC(y, lastMonth, 0)).getUTCDate();
  return `${y}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export function evaluateRevenueThreshold(input: ThresholdInput): ThresholdResult {
  const { year, todayKey, threshold } = input;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const thresholdCents = cents(threshold);

  // Year to date + first day the running total reaches the threshold.
  let ytd = 0;
  let sales = 0;
  let imported = 0;
  let returns = 0;
  let crossedOn: string | null = null;
  for (const d of input.days) {
    if (d.day < yearStart || d.day > todayKey) continue;
    ytd += cents(d.net);
    sales += cents(d.sales);
    imported += cents(d.imported);
    returns += cents(d.returns);
    if (crossedOn === null && ytd >= thresholdCents) crossedOn = d.day;
  }

  // Run-rate forecast over the recent window, starting no earlier than the store's first sale.
  const windowFloor = addBusinessDays(todayKey, -(FORECAST_WINDOW_DAYS - 1));
  const windowStart = input.firstActivityKey && input.firstActivityKey > windowFloor ? input.firstActivityKey : windowFloor;
  const windowDays = input.firstActivityKey && input.firstActivityKey <= todayKey
    ? businessDaysInclusiveBetween(windowStart, todayKey)
    : 0;
  const windowNet = input.days
    .filter((d) => d.day >= windowStart && d.day <= todayKey)
    .reduce((sum, d) => sum + cents(d.net), 0);
  const sufficientData = windowDays >= MIN_FORECAST_DAYS;
  const avgDailyCents = sufficientData ? windowNet / windowDays : null;
  const remainingDays = Math.max(0, businessDaysInclusiveBetween(todayKey, yearEnd) - 1);

  let projectedYearEnd: number | null = null;
  let projectedCrossDate: string | null = null;
  if (avgDailyCents !== null) {
    projectedYearEnd = vnd(Math.round(ytd + Math.max(0, avgDailyCents) * remainingDays));
    if (ytd < thresholdCents && avgDailyCents > 0) {
      const crossKey = addBusinessDays(todayKey, Math.ceil((thresholdCents - ytd) / avgDailyCents));
      projectedCrossDate = crossKey <= yearEnd ? crossKey : null;
    }
  }

  const ratio = threshold > 0 ? ytd / thresholdCents : 0;
  const reached = ytd >= thresholdCents;
  let level: ThresholdLevel = 'NONE';
  if (cents(input.priorYearRevenue) >= thresholdCents) level = 'PRIOR_YEAR_REACHED';
  else if (reached) level = 'REACHED';
  else if (ratio >= WARNING_RATIO) level = 'WARNING';
  else if (ratio >= WATCH_RATIO || (projectedYearEnd !== null && cents(projectedYearEnd) >= thresholdCents)) level = 'WATCH';

  // Returns can pull the running total back under the threshold: the hint follows the current total.
  const registrationDeadlineHint = level === 'REACHED' && crossedOn
    ? addBusinessDays(quarterEndKey(crossedOn), REGISTRATION_GRACE_DAYS)
    : null;

  return {
    year,
    threshold,
    ytdRevenue: vnd(ytd),
    ratio: Math.round(ratio * 10000) / 10000,
    level,
    breakdown: { sales: vnd(sales), imported: vnd(imported), returns: vnd(returns) },
    priorYearRevenue: input.priorYearRevenue,
    crossedOn: reached ? crossedOn : null,
    registrationDeadlineHint,
    forecast: {
      sufficientData,
      windowDays,
      avgDailyRevenue: avgDailyCents === null ? null : Math.round(avgDailyCents) / 100,
      projectedYearEnd,
      projectedCrossDate,
    },
  };
}
