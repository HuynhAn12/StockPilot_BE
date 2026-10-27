import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { env } from '../../config/env';
import { DecisionEngineService } from '../../modules/decision-engine/decision-engine.service';
import { DailySalesSummaryService } from '../../modules/daily-sales-summary/daily-sales-summary.service';
import { DecisionRecomputeQueue } from '../../modules/decision-engine/recompute-queue';
import { toBusinessDateKey } from '../utils/business-date';
import { logger } from '../logger';

/**
 * Post-commit trigger facade for the Decision Engine.
 *
 * Callers invoke these methods only after their business transaction has committed. Each method
 * enqueues work on a coalescing in-process queue (see DecisionRecomputeQueue) and resolves when that
 * work has been processed. Promises never reject, so fire-and-forget callers are safe.
 */
export class BusinessSyncService {
  private static instance: BusinessSyncService | null = null;
  private readonly queue: DecisionRecomputeQueue;

  constructor(private readonly prisma: PrismaClient = defaultPrisma) {
    this.queue = new DecisionRecomputeQueue(
      new DecisionEngineService(prisma),
      new DailySalesSummaryService(prisma),
      env.DECISION_RECOMPUTE_DEBOUNCE_MS
    );
  }

  public static getInstance(prisma: PrismaClient = defaultPrisma): BusinessSyncService {
    if (!BusinessSyncService.instance) {
      BusinessSyncService.instance = new BusinessSyncService(prisma);
    }
    return BusinessSyncService.instance;
  }

  /**
   * Runs a post-commit trigger without ever affecting the caller: synchronous throws and async
   * rejections are logged, never propagated. Use after the business transaction has committed.
   */
  static fireAndForget(prisma: PrismaClient, trigger: (sync: BusinessSyncService) => Promise<unknown>): void {
    try {
      trigger(BusinessSyncService.getInstance(prisma)).catch((error) => {
        logger.warn('decision_trigger_failed', { error });
      });
    } catch (error) {
      logger.warn('decision_trigger_failed', { error });
    }
  }

  /** Processes queued work immediately (graceful shutdown). */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /**
   * Re-evaluates risk alerts, coverage, and pricing recommendations for a list of SKUs.
   */
  async syncStockItems(storeId: number, stockItemIds: number[]): Promise<void> {
    await this.queue.enqueue(storeId, Array.from(new Set(stockItemIds)));
  }

  /**
   * Called immediately after a POS sale or Order fulfillment.
   * Updates today's sales summary facts and re-evaluates sold stock items.
   */
  async syncAfterSale(storeId: number, stockItemIds: number[]): Promise<void> {
    await this.queue.enqueue(storeId, stockItemIds, { summaryDateKeys: [toBusinessDateKey(new Date())] });
  }

  /**
   * Called after inventory inflow (nhập kho), outflow (xuất kho), audit adjustment (kiểm kê),
   * stock-take completion, or product import.
   */
  async syncAfterInventoryMovement(storeId: number, stockItemIds: number[]): Promise<void> {
    await this.queue.enqueue(storeId, stockItemIds);
  }

  /**
   * Called after an order is canceled, returned, or refunded.
   * Returns are attributed to the business date they are recorded, so today's summary is rebuilt.
   */
  async syncAfterCancelOrReturn(storeId: number, stockItemIds: number[]): Promise<void> {
    await this.queue.enqueue(storeId, stockItemIds, { summaryDateKeys: [toBusinessDateKey(new Date())] });
  }

  /**
   * Called after a stock item's selling price or cost price changes.
   */
  async syncAfterPriceChange(storeId: number, stockItemId: number | number[]): Promise<void> {
    await this.queue.enqueue(storeId, Array.isArray(stockItemId) ? stockItemId : [stockItemId]);
  }

  /**
   * Called after historical sales are imported: rebuilds the summaries of the imported date range
   * (inclusive) before re-evaluating the affected SKUs.
   */
  async syncAfterHistoricalImport(storeId: number, stockItemIds: number[], soldAtRange: { from: Date; to: Date }): Promise<void> {
    await this.queue.enqueue(storeId, stockItemIds, {
      summaryDateKeys: [toBusinessDateKey(soldAtRange.from), toBusinessDateKey(soldAtRange.to)],
    });
  }
}
