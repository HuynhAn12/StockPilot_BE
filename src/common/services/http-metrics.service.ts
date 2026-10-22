/**
 * In-process HTTP metrics for the admin health screen: hourly buckets for the last 24 hours plus the
 * most recent server errors. Resets on restart and counts only this instance, which is enough for the
 * single-instance MVP deployment; use the hosting provider's metrics when running several instances.
 */
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;
const RECENT_ERROR_LIMIT = 20;

interface HourBucket {
  hourStart: number;
  total: number;
  serverErrors: number;
  latencySumMs: number;
}

export interface RecentServerError {
  at: string;
  method: string;
  path: string;
  statusCode: number;
  requestId?: string;
}

const buckets = new Map<number, HourBucket>();
let recentErrors: RecentServerError[] = [];
const startedAt = Date.now();

function prune(now: number) {
  const oldest = Math.floor(now / HOUR_MS) * HOUR_MS - (WINDOW_HOURS - 1) * HOUR_MS;
  for (const hourStart of buckets.keys()) {
    if (hourStart < oldest) buckets.delete(hourStart);
  }
}

export const HttpMetricsService = {
  record(entry: { method: string; path: string; statusCode: number; latencyMs: number; requestId?: string }, now = Date.now()) {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    let bucket = buckets.get(hourStart);
    if (!bucket) {
      bucket = { hourStart, total: 0, serverErrors: 0, latencySumMs: 0 };
      buckets.set(hourStart, bucket);
      prune(now);
    }
    bucket.total += 1;
    bucket.latencySumMs += entry.latencyMs;

    if (entry.statusCode >= 500) {
      bucket.serverErrors += 1;
      recentErrors = [
        {
          at: new Date(now).toISOString(),
          method: entry.method,
          path: entry.path,
          statusCode: entry.statusCode,
          requestId: entry.requestId,
        },
        ...recentErrors,
      ].slice(0, RECENT_ERROR_LIMIT);
    }
  },

  snapshot(now = Date.now()) {
    prune(now);
    const hours = [...buckets.values()].sort((a, b) => a.hourStart - b.hourStart);
    const total = hours.reduce((sum, b) => sum + b.total, 0);
    const serverErrors = hours.reduce((sum, b) => sum + b.serverErrors, 0);
    const latencySumMs = hours.reduce((sum, b) => sum + b.latencySumMs, 0);

    return {
      since: new Date(Math.max(startedAt, now - WINDOW_HOURS * HOUR_MS)).toISOString(),
      requests: total,
      serverErrors,
      errorRate: total > 0 ? Number((serverErrors / total).toFixed(4)) : 0,
      avgLatencyMs: total > 0 ? Math.round(latencySumMs / total) : 0,
      hourly: hours.map((b) => ({
        hour: new Date(b.hourStart).toISOString(),
        requests: b.total,
        serverErrors: b.serverErrors,
      })),
      recentServerErrors: recentErrors
        .filter((e) => Date.parse(e.at) > now - WINDOW_HOURS * HOUR_MS)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    };
  },

  /** Test helper. */
  reset() {
    buckets.clear();
    recentErrors = [];
  },
};
