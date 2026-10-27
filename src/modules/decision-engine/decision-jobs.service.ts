import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { DbLeaseService } from '../../common/services/db-lease.service';
import { addBusinessDays, businessDateKeyToDate, toBusinessDateKey } from '../../common/utils/business-date';
import { DailySalesSummaryService } from '../daily-sales-summary/daily-sales-summary.service';
import { DecisionEngineService } from './decision-engine.service';

/** Snapshots older than this are pruned by the nightly job; active SKUs get a fresh one every night. */
export const DECISION_SNAPSHOT_RETENTION_DAYS = 90;

const NIGHTLY_LEASE = 'decision-nightly';
const NIGHTLY_LEASE_TTL_MS = 2 * 60 * 60 * 1000;
const RECALCULATE_LEASE_TTL_MS = 15 * 60 * 1000;
const NIGHTLY_LAST_RUN_KEY = 'job:decision-nightly:last-run';
const NIGHTLY_SUMMARY_DAYS = 3;
const NIGHTLY_PAGE_SIZE = 100;
const SNAPSHOT_PRUNE_CHUNK = 5000;

export interface NightlyRunReport {
  businessDate: string;
  stores: number;
  processedSkus: number;
  failedSkus: number;
  expiredRecommendations: number;
  prunedSnapshots: number;
  durationMs: number;
}

/**
 * Orchestrates Decision Engine batch work: owner-triggered recalculation and the nightly
 * reconciliation. Exclusivity uses expiring DB leases; correctness relies on recomputeSku being
 * idempotent and row-locked, so a lost lease can only cause duplicate (harmless) work.
 */
export class DecisionJobsService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly engine: DecisionEngineService = new DecisionEngineService(prisma),
    private readonly summaries: DailySalesSummaryService = new DailySalesSummaryService(prisma),
    private readonly leases: DbLeaseService = new DbLeaseService(prisma)
  ) {}

  /** Owner-triggered, bounded recalculation. Rejects with 409 while another one runs for the store. */
  async recalculateStore(storeId: number, options: { afterId?: number; limit?: number } = {}) {
    const outcome = await this.leases.runExclusive(`decision-recalc:${storeId}`, RECALCULATE_LEASE_TTL_MS, () =>
      this.engine.recalculateStore(storeId, options)
    );

    if (!outcome.acquired) {
      throw new ConflictError('DECISION_RECALCULATION_IN_PROGRESS');
    }

    logger.info('decision_recalculate_completed', {
      storeId,
      processed: outcome.result.processed,
      failed: outcome.result.failureCount,
      remaining: outcome.result.remaining,
    });
    return outcome.result;
  }

  /**
   * Nightly reconciliation, at most once per business date across all instances. Returns null when
   * the run was skipped (already completed today, or another instance holds the lease).
   */
  async runNightly(now: Date = new Date()): Promise<NightlyRunReport | null> {
    const businessDate = toBusinessDateKey(now);
    if ((await this.getLastNightlyRunDate()) === businessDate) {
      return null;
    }

    const outcome = await this.leases.runExclusive(NIGHTLY_LEASE, NIGHTLY_LEASE_TTL_MS, async () => {
      // Double-checked: another instance may have finished while we waited for the lease.
      if ((await this.getLastNightlyRunDate()) === businessDate) {
        return null;
      }

      const report = await this.reconcileAllStores(now, businessDate);
      await this.prisma.systemSetting.upsert({
        where: { key: NIGHTLY_LAST_RUN_KEY },
        create: {
          key: NIGHTLY_LAST_RUN_KEY,
          valueJson: { ...report },
          description: 'Internal Decision Engine nightly job state (not a user setting)',
        },
        update: { valueJson: { ...report } },
      });
      return report;
    });

    return outcome.acquired ? outcome.result : null;
  }

  private async reconcileAllStores(now: Date, businessDate: string): Promise<NightlyRunReport> {
    const startedAt = Date.now();
    const stores = await this.prisma.store.findMany({ where: { isActive: true }, select: { id: true } });
    const summaryFrom = businessDateKeyToDate(addBusinessDays(businessDate, -(NIGHTLY_SUMMARY_DAYS - 1)));
    const summaryTo = businessDateKeyToDate(businessDate);

    let processedSkus = 0;
    let failedSkus = 0;
    for (const store of stores) {
      try {
        // Late returns and cancellations only touch recent days; full 90-day rebuilds stay on demand.
        await this.summaries.rebuildDailySalesSummary(store.id, summaryFrom, summaryTo);
      } catch (error) {
        logger.warn('decision_nightly_summary_failed', { storeId: store.id, error });
      }

      let afterId: number | undefined;
      do {
        const page = await this.engine.recomputeStorePage(store.id, { afterId, limit: NIGHTLY_PAGE_SIZE });
        processedSkus += page.processed;
        failedSkus += page.failedStockItemIds.length;
        afterId = page.nextCursor ?? undefined;
      } while (afterId !== undefined);
    }

    const expiredRecommendations = await this.expireOverdueRecommendations(now);
    const prunedSnapshots = await this.pruneSnapshots(now);

    return {
      businessDate,
      stores: stores.length,
      processedSkus,
      failedSkus,
      expiredRecommendations,
      prunedSnapshots,
      durationMs: Date.now() - startedAt,
    };
  }

  /** PENDING recommendations past expiresAt can no longer be accepted; make that explicit. */
  async expireOverdueRecommendations(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.pricingRecommendation.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  /** Deletes snapshots past retention in bounded chunks to keep each statement's lock footprint small. */
  async pruneSnapshots(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DECISION_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM decision_snapshots WHERE calculatedAt < ${cutoff} LIMIT ${SNAPSHOT_PRUNE_CHUNK}`;
      total += deleted;
      if (deleted < SNAPSHOT_PRUNE_CHUNK) {
        return total;
      }
    }
  }

  private async getLastNightlyRunDate(): Promise<string | null> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: NIGHTLY_LAST_RUN_KEY },
      select: { valueJson: true },
    });
    return (row?.valueJson as { businessDate?: string } | null)?.businessDate ?? null;
  }
}
