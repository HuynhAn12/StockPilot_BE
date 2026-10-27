import { env } from '../../config/env';
import { logger } from '../../common/logger';
import { DecisionJobsService } from './decision-jobs.service';
import { recordJobFailure } from '../../common/services/job-state.service';

const TICK_INTERVAL_MS = 60 * 1000;

/** Enabled explicitly via DECISION_SCHEDULER_ENABLED, otherwise only in production. */
export function isDecisionSchedulerEnabled(): boolean {
  if (env.DECISION_SCHEDULER_ENABLED !== undefined) {
    return env.DECISION_SCHEDULER_ENABLED === 'true';
  }
  return env.NODE_ENV === 'production';
}

/** Hour of day (0-23) of `date` in the given IANA time zone. */
export function hourInTimeZone(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour);
}

/**
 * Minute ticker that triggers the nightly Decision Engine reconciliation during the configured local
 * hour. Once-per-day and cross-instance exclusivity are enforced by DecisionJobsService; this class
 * only prevents overlapping runs within the process.
 */
export class DecisionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly jobs: Pick<DecisionJobsService, 'runNightly'> = new DecisionJobsService(),
    private readonly nightlyHour: number = env.DECISION_NIGHTLY_HOUR,
    private readonly timeZone: string = env.APP_TIMEZONE
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('decision_scheduler_started', { nightlyHour: this.nightlyHour, timeZone: this.timeZone });
  }

  /** Stops future ticks and waits for an in-flight run to finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.running || hourInTimeZone(now, this.timeZone) !== this.nightlyHour) {
      return;
    }

    this.running = (async () => {
      try {
        const report = await this.jobs.runNightly(now);
        if (report) {
          logger.info('decision_nightly_completed', { ...report });
        }
      } catch (error) {
        logger.error('decision_nightly_failed', { error });
        await recordJobFailure('decision-nightly', error);
      } finally {
        this.running = null;
      }
    })();

    await this.running;
  }
}
