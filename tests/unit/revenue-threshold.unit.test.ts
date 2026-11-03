import { evaluateRevenueThreshold, quarterEndKey, ThresholdInput } from '../../src/modules/tax-support/revenue-threshold';
import type { LedgerDay } from '../../src/modules/tax-support/revenue-ledger.service';

const T = 1_000_000_000;

const day = (key: string, sales: number, extra: Partial<LedgerDay> = {}): LedgerDay => {
  const imported = extra.imported ?? 0;
  const returns = extra.returns ?? 0;
  return { day: key, sales, imported, returns, net: sales + imported - returns, orderCount: 1, firstOrderNo: 'HD1', lastOrderNo: 'HD1', ...extra };
};

/** `count` consecutive days ending at `endKey`, each with `perDay` sales. */
function series(endKey: string, count: number, perDay: number): LedgerDay[] {
  const end = new Date(`${endKey}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end.getTime() - (count - 1 - i) * 86_400_000);
    return day(d.toISOString().slice(0, 10), perDay);
  });
}

const base = (over: Partial<ThresholdInput> = {}): ThresholdInput => ({
  year: 2026, todayKey: '2026-11-01', threshold: T, days: [], priorYearRevenue: 0, firstActivityKey: '2025-01-01', ...over,
});

describe('evaluateRevenueThreshold', () => {
  it('returns NONE with zero revenue and never divides by zero', () => {
    const r = evaluateRevenueThreshold(base({ firstActivityKey: null }));
    expect(r).toMatchObject({ ytdRevenue: 0, ratio: 0, level: 'NONE', crossedOn: null, registrationDeadlineHint: null });
    expect(r.forecast).toMatchObject({ sufficientData: false, windowDays: 0, avgDailyRevenue: null, projectedYearEnd: null });
  });

  it('reaches the threshold at exactly 1 tỷ (từ 1 tỷ trở lên) and dates the crossing by prefix sum', () => {
    const r = evaluateRevenueThreshold(base({
      days: [day('2026-03-10', 600_000_000), day('2026-08-20', 400_000_000), day('2026-09-02', 5_000_000)],
    }));
    expect(r.level).toBe('REACHED');
    expect(r.crossedOn).toBe('2026-08-20');
    // Q3 ends 30/09 → +30 days.
    expect(r.registrationDeadlineHint).toBe('2026-10-30');
  });

  it('stays below at 999.999.999 đ', () => {
    const r = evaluateRevenueThreshold(base({ days: [day('2026-05-01', 999_999_999)] }));
    expect(r.level).not.toBe('REACHED');
    expect(r.crossedOn).toBeNull();
  });

  it('follows the current total when returns pull it back under the threshold', () => {
    const r = evaluateRevenueThreshold(base({
      days: [day('2026-06-01', 1_000_000_000), day('2026-06-05', 0, { returns: 50_000_000 })],
    }));
    expect(r.ytdRevenue).toBe(950_000_000);
    expect(r.level).toBe('WARNING');
    expect(r.crossedOn).toBeNull();
    expect(r.registrationDeadlineHint).toBeNull();
  });

  it('flags PRIOR_YEAR_REACHED from last year’s revenue even when this year is low', () => {
    const r = evaluateRevenueThreshold(base({ priorYearRevenue: 1_200_000_000, days: [day('2026-02-01', 10_000_000)] }));
    expect(r.level).toBe('PRIOR_YEAR_REACHED');
    expect(r.registrationDeadlineHint).toBeNull();
  });

  it('maps ratio to WATCH (≥70%) and WARNING (≥90%)', () => {
    const at = (amount: number) => evaluateRevenueThreshold(base({ firstActivityKey: '2026-10-25', days: [day('2026-10-25', amount)] })).level;
    expect(at(690_000_000)).toBe('NONE');
    expect(at(700_000_000)).toBe('WATCH');
    expect(at(900_000_000)).toBe('WARNING');
  });

  it('only counts days inside the current year and up to today', () => {
    const r = evaluateRevenueThreshold(base({
      days: [day('2025-12-31', 500_000_000), day('2026-01-01', 100_000_000), day('2026-11-02', 900_000_000)],
    }));
    expect(r.ytdRevenue).toBe(100_000_000);
    expect(r.breakdown).toEqual({ sales: 100_000_000, imported: 0, returns: 0 });
  });

  it('adds imported history and subtracts returns in the breakdown', () => {
    const r = evaluateRevenueThreshold(base({ days: [day('2026-04-01', 200_000_000, { imported: 50_000_000, returns: 10_000_000 })] }));
    expect(r.ytdRevenue).toBe(240_000_000);
    expect(r.breakdown).toEqual({ sales: 200_000_000, imported: 50_000_000, returns: 10_000_000 });
  });

  describe('forecast', () => {
    it('projects the year end from the last 90 days run-rate and raises WATCH when it would cross', () => {
      // 90 days × 6 tr = 540 tr so far; 60 days left × 6 tr → 900 tr… plus earlier sales below.
      const recent = series('2026-11-01', 90, 6_000_000);
      const r = evaluateRevenueThreshold(base({ days: [day('2026-02-01', 150_000_000), ...recent] }));
      expect(r.ytdRevenue).toBe(690_000_000);
      expect(r.forecast).toMatchObject({ sufficientData: true, windowDays: 90, avgDailyRevenue: 6_000_000 });
      expect(r.forecast.projectedYearEnd).toBe(690_000_000 + 6_000_000 * 60);
      // (1 tỷ − 690 tr) / 6 tr = 51.67 → 52 days after 01/11.
      expect(r.forecast.projectedCrossDate).toBe('2026-12-23');
      expect(r.level).toBe('WATCH');
    });

    it('does not forecast with fewer than 14 days of history', () => {
      const r = evaluateRevenueThreshold(base({ firstActivityKey: '2026-10-25', days: series('2026-11-01', 8, 50_000_000) }));
      expect(r.forecast).toMatchObject({ sufficientData: false, windowDays: 8, projectedYearEnd: null, projectedCrossDate: null });
    });

    it('averages over days since the first sale, not over days before the store existed', () => {
      const r = evaluateRevenueThreshold(base({ firstActivityKey: '2026-10-03', days: series('2026-11-01', 30, 2_000_000) }));
      expect(r.forecast.windowDays).toBe(30);
      expect(r.forecast.avgDailyRevenue).toBe(2_000_000);
    });

    it('leaves the cross date empty when the run-rate cannot reach the threshold this year', () => {
      const r = evaluateRevenueThreshold(base({ days: series('2026-11-01', 90, 1_000_000) }));
      expect(r.forecast.projectedCrossDate).toBeNull();
      expect(r.level).toBe('NONE');
    });
  });
});

describe('quarterEndKey', () => {
  it.each([
    ['2026-01-15', '2026-03-31'],
    ['2026-04-01', '2026-06-30'],
    ['2026-09-30', '2026-09-30'],
    ['2026-12-31', '2026-12-31'],
    ['2028-02-10', '2028-03-31'],
  ])('%s → %s', (input, expected) => {
    expect(quarterEndKey(input)).toBe(expected);
  });
});
