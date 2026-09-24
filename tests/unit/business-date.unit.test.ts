import {
  businessDateKeyToDate,
  businessDateRangeToUtc,
  toBusinessDateKey,
  validateTimeZone,
} from '../../src/common/utils/business-date';

describe('Business date utilities', () => {
  const timeZone = 'Asia/Ho_Chi_Minh';

  it('maps UTC timestamps to Vietnam business dates around midnight', () => {
    expect(toBusinessDateKey(new Date('2026-09-24T16:59:59.999Z'), timeZone)).toBe('2026-09-24');
    expect(toBusinessDateKey(new Date('2026-09-24T17:00:00.000Z'), timeZone)).toBe('2026-09-25');
    expect(toBusinessDateKey(new Date('2026-09-25T16:59:59.999Z'), timeZone)).toBe('2026-09-25');
    expect(toBusinessDateKey(new Date('2026-09-24T19:00:00.000Z'), timeZone)).toBe('2026-09-25');
  });

  it('converts a business date key to its half-open UTC source range', () => {
    const range = businessDateRangeToUtc('2026-09-25', timeZone);

    expect(range.startUtc.toISOString()).toBe('2026-09-24T17:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-09-25T17:00:00.000Z');
    expect(businessDateKeyToDate('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('validates IANA timezone names', () => {
    expect(validateTimeZone(timeZone)).toBe(true);
    expect(validateTimeZone('INVALID_ZONE')).toBe(false);
  });
});
