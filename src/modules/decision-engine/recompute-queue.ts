import { NotFoundError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { businessDateKeyToDate } from '../../common/utils/business-date';
import { DailySalesSummaryService } from '../daily-sales-summary/daily-sales-summary.service';
import { DecisionEngineService } from './decision-engine.service';

interface PendingStoreWork {
  stockItemIds: Set<number>;
  /** Business date keys (YYYY-MM-DD) whose DailySalesSummary must be rebuilt before recomputing. */
  summaryDateKeys: Set<string>;
}

export interface EnqueueRecomputeOptions {
  summaryDateKeys?: string[];
}

/**
 * In-process, coalescing queue for post-commit Decision Engine work.
 *
 * - Business transactions only enqueue after commit; the engine never runs inside a sale.
 * - Requests are coalesced per (storeId, stockItemId). This is sound because recomputeSku is an
 *   idempotent function of the current database state: N events collapse into one run.
 * - One drain runs at a time per process (bounded concurrency); work arriving during a drain is
 *   picked up by the next cycle.
 * - Delivery is at-most-once: pending work is lost if the process stops. The nightly job reconciles
 *   every active SKU, which bounds staleness to one day.
 */
export class DecisionRecomputeQueue {
  private pending = new Map<number, PendingStoreWork>();
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly engine: Pick<DecisionEngineService, 'recomputeSku'>,
    private readonly summaries: Pick<DailySalesSummaryService, 'rebuildDailySalesSummary'>,
    private readonly debounceMs = 500
  ) {}

  /** Resolves once the drain cycle that includes this work has finished. Never rejects. */
  enqueue(storeId: number, stockItemIds: number[], options: EnqueueRecomputeOptions = {}): Promise<void> {
    const ids = stockItemIds.filter((id) => Number.isInteger(id) && id > 0);
    const dateKeys = options.summaryDateKeys ?? [];
    if (ids.length === 0 && dateKeys.length === 0) {
      return Promise.resolve();
    }

    const work = this.pending.get(storeId) ?? { stockItemIds: new Set<number>(), summaryDateKeys: new Set<string>() };
    ids.forEach((id) => work.stockItemIds.add(id));
    dateKeys.forEach((key) => work.summaryDateKeys.add(key));
    this.pending.set(storeId, work);

    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.schedule();
    return done;
  }

  /** Number of SKUs waiting to be recomputed (for logs and tests). */
  pendingSkuCount(): number {
    let count = 0;
    this.pending.forEach((work) => (count += work.stockItemIds.size));
    return count;
  }

  /** Processes everything queued so far immediately (graceful shutdown, tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.drain();
  }

  private schedule() {
    if (this.timer || this.draining) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) {
      return this.draining;
    }

    this.draining = (async () => {
      try {
        while (this.pending.size > 0) {
          const batch = this.pending;
          const waiters = this.waiters;
          this.pending = new Map();
          this.waiters = [];

          for (const [storeId, work] of batch) {
            await this.processStore(storeId, work);
          }
          waiters.forEach((resolve) => resolve());
        }
      } finally {
        this.draining = null;
        if (this.pending.size > 0) {
          this.schedule();
        }
      }
    })();

    return this.draining;
  }

  private async processStore(storeId: number, work: PendingStoreWork) {
    if (work.summaryDateKeys.size > 0) {
      const keys = Array.from(work.summaryDateKeys).sort();
      try {
        await this.summaries.rebuildDailySalesSummary(
          storeId,
          businessDateKeyToDate(keys[0]),
          businessDateKeyToDate(keys[keys.length - 1])
        );
      } catch (error) {
        logger.warn('decision_summary_rebuild_failed', { storeId, from: keys[0], to: keys[keys.length - 1], error });
      }
    }

    let failed = 0;
    for (const stockItemId of work.stockItemIds) {
      try {
        await this.engine.recomputeSku(storeId, stockItemId);
      } catch (error) {
        // A SKU deleted or moved after the event is not an error worth reporting.
        if (!(error instanceof NotFoundError)) {
          failed++;
          logger.warn('decision_recompute_failed', { storeId, stockItemId, error });
        }
      }
    }

    logger.info('decision_recompute_batch_completed', {
      storeId,
      skuCount: work.stockItemIds.size,
      failed,
      summaryDays: work.summaryDateKeys.size,
    });
  }
}
