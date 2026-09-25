import { env } from '../../config/env';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');

  if (!year || !month || !day) {
    throw new Error(`Unable to format business date for timezone ${timeZone}`);
  }

  return { year, month, day };
}

function parseDateKey(dateKey: string) {
  if (!DATE_KEY_PATTERN.test(dateKey)) {
    throw new Error(`Invalid business date key: ${dateKey}`);
  }

  const [year, month, day] = dateKey.split('-').map(Number);
  return { year, month, day };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second'))
  );

  return asUtc - date.getTime();
}

function zonedLocalTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timeZone);

  return new Date(utcGuess - secondOffset);
}

export function toBusinessDateKey(date: Date, timeZone = env.APP_TIMEZONE): string {
  const { year, month, day } = getDateParts(date, timeZone);
  return `${year}-${month}-${day}`;
}

export function businessDateKeyToDate(dateKey: string): Date {
  parseDateKey(dateKey);
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function canonicalDateToBusinessDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function businessDateRangeToUtc(dateKey: string, timeZone = env.APP_TIMEZONE) {
  const { year, month, day } = parseDateKey(dateKey);
  const startUtc = zonedLocalTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const endUtc = zonedLocalTimeToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    0,
    0,
    0,
    0,
    timeZone
  );

  return { startUtc, endUtc };
}

export function businessDateRangeFromDates(fromDate: Date, toDate: Date, timeZone = env.APP_TIMEZONE) {
  const fromKey = toBusinessDateKey(fromDate, timeZone);
  const toKey = toBusinessDateKey(toDate, timeZone);
  const { startUtc } = businessDateRangeToUtc(fromKey, timeZone);
  const { endUtc } = businessDateRangeToUtc(toKey, timeZone);

  return { fromKey, toKey, startUtc, endUtc };
}

export function addBusinessDays(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return canonicalDateToBusinessDateKey(date);
}

export function businessDaysInclusiveBetween(fromDateKey: string, toDateKey: string): number {
  const from = businessDateKeyToDate(fromDateKey);
  const to = businessDateKeyToDate(toDateKey);
  const diffMs = to.getTime() - from.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

export function businessDaysElapsed(fromDateKey: string, toDateKey: string): number {
  return Math.max(0, businessDaysInclusiveBetween(fromDateKey, toDateKey) - 1);
}
