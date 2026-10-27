import { DecisionSnapshot, PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { DailySalesSummaryService } from '../daily-sales-summary/daily-sales-summary.service';
import { EngineConfigService, ResolvedEngineConfig } from './engine-config.service';
import { DemandMetricsService, DemandMetricsResult } from './demand-metrics.service';
import { RiskEvaluator, SafetyStockResult } from './risk-evaluator';
import { DecisionDataStatus, PricingEvaluator, PricingEvaluationResult } from './pricing-evaluator';
import { DECISION_ENGINE_VERSION } from './engine-defaults';
import { classifyRisk } from './risk-classification';
import { AlertEvaluationInput, AlertService } from '../alerts/alert.service';
import { PricingService } from '../pricing/pricing.service';
import { logger } from '../../common/logger';
import { env } from '../../config/env';
import {
  addBusinessDays,
  businessDateKeyToDate,
  businessDaysElapsed,
  businessDaysInclusiveBetween,
  toBusinessDateKey,
} from '../../common/utils/business-date';

export interface SkuDecisionAnalysisResult {
  stockItemId: number;
  sku: string;
  productName: string;
  categoryName?: string | null;
  inventory: {
    onHand: number;
    reserved: number;
    available: number;
    minStockLevel: number;
    maxStockLevel: number;
  };
  /** OK when the SKU has at least minimumHistoryDays of exposure; estimates are suppressed otherwise. */
  dataStatus: DecisionDataStatus;
  /** Exposure-based history depth H (days, capped at 90) used for every demand estimate. */
  historyDays: number;
  demand: DemandMetricsResult;
  coverage: {
    safetyStock: number;
    safetyStockMethod: string;
    reorderPoint: number;
    /** Suggested order quantity when available stock is at or below the reorder point, else 0. */
    reorderQuantity: number;
    daysOfCover: number | null;
  };
  risk: {
    stockout: number;
    stockoutSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    overstock: number;
    overstockSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    slowMoving: boolean;
    deadStock: boolean;
    deadStockSeverity: 'NONE' | 'WARNING' | 'CRITICAL';
    daysSinceLastSale: number | null;
    /** Days since the last sale, or since first stock-in when the SKU never sold. */
    daysWithoutSale: number | null;
    deadStockCostValue: number;
    deadStockRetailValue: number;
    unusualDemand: {
      isAnomaly: boolean;
      type: string;
      zScore: number;
    };
  };
  confidence: {
    score: number;
    level: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  pricing: {
    costPrice: number;
    sellingPrice: number;
    minimumPrice: number;
    expectedMarginPct: number;
  };
  pricingEvaluation: PricingEvaluationResult;
  engineConfig: ResolvedEngineConfig;
  engineVersion: string;
  factors: Array<{ code: string; label: string; impact: string; value?: unknown }>;
  calculatedAt: string;
}

export interface AnalyzeSkuOptions {
  persist?: boolean;
  evaluationDate?: Date;
}

/** Shape version of the JSON stored in DecisionSnapshot (independent of the engine formula version). */
export const DECISION_SNAPSHOT_SCHEMA_VERSION = 2;

/** A snapshot older than this is reported as stale even if no source change was detected (nightly run + slack). */
export const DECISION_SNAPSHOT_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export interface DecisionFreshness {
  /** True when the result may not reflect the latest inventory, price, or config changes. */
  stale: boolean;
  /** When the persisted analysis was calculated; null when no usable snapshot exists. */
  snapshotAt: string | null;
  /** SNAPSHOT: read from DecisionSnapshot. LIVE: computed read-only because no usable snapshot exists. */
  source: 'SNAPSHOT' | 'LIVE';
}

export interface SkuDecisionReadModel {
  analysis: SkuDecisionAnalysisResult;
  freshness: DecisionFreshness;
}

type DecisionDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Pure staleness rule: a snapshot is stale if any tracked source changed after it was calculated
 * (inventory movement, StockItem price/cost/threshold update, engine config update) or it exceeded
 * the maximum age. calculatedAt is taken before the evaluation reads, so the rule errs towards stale.
 */
export function isDecisionSnapshotStale(
  calculatedAt: Date,
  sourceChangedAt: Array<Date | null | undefined>,
  now: Date = new Date(),
  maxAgeMs: number = DECISION_SNAPSHOT_MAX_AGE_MS,
  snapshotVersion: string = DECISION_ENGINE_VERSION
): boolean {
  // A snapshot produced by different formulas is never current, whatever its age.
  if (snapshotVersion !== DECISION_ENGINE_VERSION) {
    return true;
  }
  if (now.getTime() - calculatedAt.getTime() > maxAgeMs) {
    return true;
  }
  return sourceChangedAt.some((changedAt) => Boolean(changedAt) && changedAt!.getTime() > calculatedAt.getTime());
}

export class DecisionEngineService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly dailySalesSummaryService: DailySalesSummaryService = new DailySalesSummaryService(prisma),
    private readonly engineConfigService: EngineConfigService = new EngineConfigService(prisma),
    private readonly demandMetricsService: DemandMetricsService = new DemandMetricsService(),
    private readonly riskEvaluator: RiskEvaluator = new RiskEvaluator(),
    private readonly pricingEvaluator: PricingEvaluator = new PricingEvaluator(),
    private readonly alertService: AlertService = new AlertService(prisma),
    private readonly pricingService: PricingService = new PricingService(prisma)
  ) {}

  /**
   * Deterministically analyzes a single SKU. Persistence is explicit so GET handlers can remain read-only.
   * persist !== false delegates to recomputeSku (single transaction); persist: false never writes.
   */
  async analyzeSku(
    storeId: number,
    stockItemId: number,
    options: AnalyzeSkuOptions = {}
  ): Promise<SkuDecisionAnalysisResult> {
    if (options.persist !== false) {
      return this.recomputeSku(storeId, stockItemId, options);
    }
    return this.evaluateSku(this.prisma, storeId, stockItemId, options.evaluationDate ?? new Date());
  }

  /**
   * Write path. Serializes on the StockItem row, evaluates inside the same transaction (consistent
   * reads taken after the lock), then syncs alerts, the pricing recommendation, and appends a
   * DecisionSnapshot atomically. Idempotent: re-running on unchanged data yields the same rows.
   */
  async recomputeSku(
    storeId: number,
    stockItemId: number,
    options: Omit<AnalyzeSkuOptions, 'persist'> = {}
  ): Promise<SkuDecisionAnalysisResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Store-scoped lock: a foreign or missing id locks nothing and evaluateSku then raises 404.
        await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${stockItemId} AND storeId = ${storeId} FOR UPDATE`;

        const result = await this.evaluateSku(tx, storeId, stockItemId, options.evaluationDate ?? new Date());

        await this.alertService.syncAlertsForSku(
          {
            storeId,
            stockItemId,
            sku: result.sku,
            productName: result.productName,
            availableStock: result.inventory.available,
            reorderPoint: result.coverage.reorderPoint,
            stockoutScore: result.risk.stockout,
            stockoutSeverity: result.risk.stockoutSeverity,
            overstockScore: result.risk.overstock,
            overstockSeverity: result.risk.overstockSeverity,
            isSlowMoving: result.risk.slowMoving,
            isDeadStock: result.risk.deadStock,
            deadStockSeverity: result.risk.deadStockSeverity,
            daysSinceLastSale: result.risk.daysWithoutSale,
            confidenceScore: result.confidence.score,
            engineVersion: result.engineVersion,
            unusualDemand: result.risk.unusualDemand as AlertEvaluationInput['unusualDemand'],
            highRiskThreshold: result.engineConfig.highRiskThreshold,
            criticalRiskThreshold: result.engineConfig.criticalRiskThreshold,
          },
          tx
        );

        await this.pricingService.syncRecommendationInTransaction(
          tx,
          {
            storeId,
            stockItemId,
            sellingPrice: result.pricing.sellingPrice,
            costPrice: result.pricing.costPrice,
            minimumMarginPct: result.engineConfig.minimumMarginPct,
            maxMarkdownPct: result.engineConfig.maxMarkdownPct,
            maxMarkupPct: result.engineConfig.maxMarkupPct,
            daysSinceLastSale: result.risk.daysWithoutSale,
            daysOfCover: result.coverage.daysOfCover,
            overstockScore: result.risk.overstock,
            stockoutScore: result.risk.stockout,
            trend: result.demand.trend,
            confidenceScore: result.confidence.score,
            engineVersion: result.engineVersion,
            slowMovingDays: result.engineConfig.slowMovingDays,
            deadStockDays: result.engineConfig.deadStockDays,
            dataStatus: result.dataStatus,
          },
          result.pricingEvaluation
        );

        await tx.decisionSnapshot.create({
          data: {
            storeId,
            stockItemId,
            calculatedAt: new Date(result.calculatedAt),
            ...DecisionEngineService.toSnapshotPayload(result),
            version: result.engineVersion,
          },
        });

        return result;
      },
      { timeout: 15000 }
    );
  }

  /**
   * Read path for a single SKU: latest snapshot plus freshness. Falls back to a read-only live
   * evaluation when no usable snapshot exists. Never writes.
   */
  async getSkuDecision(storeId: number, stockItemId: number): Promise<SkuDecisionReadModel> {
    const [stockItem, snapshot, lastMovement, config] = await Promise.all([
      this.prisma.stockItem.findFirst({
        where: { id: stockItemId, storeId },
        select: { id: true, updatedAt: true },
      }),
      this.prisma.decisionSnapshot.findFirst({
        where: { storeId, stockItemId },
        orderBy: { calculatedAt: 'desc' },
      }),
      this.prisma.stockMovement.findFirst({
        where: { storeId, stockItemId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.engineConfig.findUnique({
        where: { storeId },
        select: { updatedAt: true },
      }),
    ]);

    if (!stockItem) {
      throw new NotFoundError('Không tìm thấy mặt hàng (StockItem)');
    }

    const analysis = snapshot ? DecisionEngineService.fromSnapshot(snapshot) : null;
    if (!snapshot || !analysis) {
      return {
        analysis: await this.evaluateSku(this.prisma, storeId, stockItemId, new Date()),
        freshness: { stale: true, snapshotAt: null, source: 'LIVE' },
      };
    }

    return {
      analysis,
      freshness: {
        stale: isDecisionSnapshotStale(
          snapshot.calculatedAt,
          [stockItem.updatedAt, lastMovement?.createdAt, config?.updatedAt],
          new Date(),
          DECISION_SNAPSHOT_MAX_AGE_MS,
          snapshot.version
        ),
        snapshotAt: snapshot.calculatedAt.toISOString(),
        source: 'SNAPSHOT',
      },
    };
  }

  /**
   * Pure evaluation (no writes). `db` is the transaction client on the write path.
   */
  private async evaluateSku(
    db: DecisionDbClient,
    storeId: number,
    stockItemId: number,
    evaluationDate: Date
  ): Promise<SkuDecisionAnalysisResult> {
    // Taken before any read so that a source change during evaluation marks the snapshot stale.
    const calculatedAt = new Date().toISOString();
    const stockItem = await db.stockItem.findFirst({
      where: { id: stockItemId, storeId },
      include: {
        product: {
          include: { category: true },
        },
        balances: true,
      },
    });

    if (!stockItem) {
      throw new NotFoundError('Không tìm thấy mặt hàng (StockItem)');
    }

    // 1. Calculate Inventory Balances
    const onHand = stockItem.balances.reduce((acc, b) => acc + b.quantity, 0);
    const reserved = stockItem.balances.reduce((acc, b) => acc + b.reservedQuantity, 0);
    const available = Math.max(0, onHand - reserved);

    // 2. Extract the 90-day series of COMPLETE business days, ending the day before evaluationDate.
    //    Today's partial day would bias every average and the anomaly test downwards.
    const evaluationBusinessDate = toBusinessDateKey(evaluationDate);
    const seriesEndDate = addBusinessDays(evaluationBusinessDate, -1);
    const series90 = await this.dailySalesSummaryService.getDailySeries(storeId, stockItemId, 90, db, seriesEndDate);

    // 3. Exposure-based history depth H: days the SKU could be sold (first sale or first stock-in,
    //    whichever is earlier), counted up to the end of the series and capped at the series length.
    const historyFacts = await this.getHistoryFacts(db, storeId, stockItemId);
    const exposureStartedAt = [historyFacts.earliestActualHistoryAt, historyFacts.firstStockedAt]
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const historyDays = exposureStartedAt
      ? Math.min(90, businessDaysInclusiveBetween(toBusinessDateKey(exposureStartedAt), seriesEndDate))
      : 0;

    // 4. Demand metrics over the exposed days only (μ = total / min(window, H), sample σ).
    const demand = this.demandMetricsService.calculateDemandMetrics(series90, historyDays);

    // 5. Last-sale semantics. daysWithoutSale also covers SKUs that never sold (age since first stock-in).
    const daysSinceLastSale = historyFacts.latestActualSaleAt
      ? businessDaysElapsed(toBusinessDateKey(historyFacts.latestActualSaleAt), evaluationBusinessDate)
      : null;
    const daysWithoutSale =
      daysSinceLastSale ??
      (exposureStartedAt ? businessDaysElapsed(toBusinessDateKey(exposureStartedAt), evaluationBusinessDate) : null);

    // 6. Get Engine Config
    const config = await this.engineConfigService.getConfig(storeId, db);

    // 7. Evidence gate and confidence. Estimates (ROP/SS, cover, trend, anomaly, demand-based pricing)
    //    require H >= minimumHistoryDays; facts (stock levels, price vs cost, age) never do.
    const dataStatus: DecisionDataStatus = historyDays >= config.minimumHistoryDays ? 'OK' : 'INSUFFICIENT_DATA';
    const hasSufficientHistory = dataStatus === 'OK';
    const confidence = this.riskEvaluator.calculateConfidence(
      historyDays,
      config.minimumHistoryDays,
      demand.daysWithSales90
    );

    // 8. Compute Safety Stock, Reorder Point, Days of Cover, Reorder Quantity
    const safetyStockResult: SafetyStockResult = hasSufficientHistory
      ? this.riskEvaluator.calculateSafetyStock({
          stdDev30: demand.stdDev30,
          leadTimeDays: config.leadTimeDays,
          serviceLevel: config.serviceLevel,
          avg30: demand.avg30,
          safetyDays: config.safetyDays,
          hasSufficientHistory,
        })
      : { safetyStock: 0, method: 'INSUFFICIENT_DATA', zScore: RiskEvaluator.getZScoreForServiceLevel(config.serviceLevel) };

    const statisticalRop = hasSufficientHistory
      ? this.riskEvaluator.calculateReorderPoint(demand.avg30, config.leadTimeDays, safetyStockResult.safetyStock)
      : 0;
    const reorderPoint = Math.max(stockItem.minStockLevel || 0, statisticalRop);

    const daysOfCover = hasSufficientHistory ? this.riskEvaluator.calculateDaysOfCover(available, demand.avg30) : null;
    const trendRatio = hasSufficientHistory ? demand.trendRatio : 1.0;

    const reorderQuantity = this.riskEvaluator.calculateReorderQuantity({
      availableStock: available,
      reorderPoint,
      avgDailyDemand: demand.avg30,
      leadTimeDays: config.leadTimeDays,
      targetCoverageDays: config.targetCoverageDays,
      safetyStock: safetyStockResult.safetyStock,
      minStockLevel: stockItem.minStockLevel,
      maxStockLevel: stockItem.maxStockLevel,
      hasSufficientHistory,
    });

    // 9. Compute Risk Scores
    const stockoutRisk = this.riskEvaluator.calculateStockoutRisk({
      availableStock: available,
      reorderPoint,
      daysOfCover,
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      trendRatio,
      lowThreshold: config.lowRiskThreshold,
      highThreshold: config.highRiskThreshold,
      criticalThreshold: config.criticalRiskThreshold,
    });

    const overstockRisk = this.riskEvaluator.calculateOverstockRisk({
      availableStock: available,
      maxStockLevel: stockItem.maxStockLevel,
      daysOfCover,
      targetCoverageDays: config.targetCoverageDays,
      trendRatio,
      lowThreshold: config.lowRiskThreshold,
      highThreshold: config.highRiskThreshold,
      criticalThreshold: config.criticalRiskThreshold,
    });

    const deadStockResult = this.riskEvaluator.evaluateSlowAndDeadStock({
      availableStock: available,
      daysSinceLastSale: daysWithoutSale,
      slowMovingDays: config.slowMovingDays,
      deadStockDays: config.deadStockDays,
      costPrice: Number(stockItem.costPrice),
      sellingPrice: Number(stockItem.sellingPrice),
    });

    // Unusual demand: last 3 complete days vs a DISJOINT baseline of the up-to-30 exposed days before them.
    const exposedSeries = historyDays > 0 ? series90.slice(series90.length - historyDays) : [];
    const recent3Series = exposedSeries.slice(Math.max(0, exposedSeries.length - 3));
    const baseline = DecisionEngineService.meanAndSampleStdDev(
      exposedSeries.slice(Math.max(0, exposedSeries.length - 33), Math.max(0, exposedSeries.length - 3))
    );
    const unusualDemand = hasSufficientHistory
      ? this.riskEvaluator.detectUnusualDemand(recent3Series, baseline.mean, baseline.stdDev)
      : { isAnomaly: false, type: 'NONE' as const, zScore: 0 };

    const pricingEval = this.pricingEvaluator.evaluatePricing({
      sellingPrice: Number(stockItem.sellingPrice),
      costPrice: Number(stockItem.costPrice),
      minimumMarginPct: config.minimumMarginPct,
      maxMarkdownPct: config.maxMarkdownPct,
      maxMarkupPct: config.maxMarkupPct,
      daysSinceLastSale: daysWithoutSale,
      daysOfCover,
      overstockScore: overstockRisk.score,
      stockoutScore: stockoutRisk.score,
      trend: demand.trend,
      confidenceScore: confidence.score,
      slowMovingDays: config.slowMovingDays,
      deadStockDays: config.deadStockDays,
      dataStatus,
    });

    const minimumPrice = PricingEvaluator.calculateMinimumPrice(Number(stockItem.costPrice), config.minimumMarginPct);
    const expectedMarginPct = Number(
      (((Number(stockItem.sellingPrice) - Number(stockItem.costPrice)) / Math.max(1, Number(stockItem.sellingPrice))) * 100).toFixed(1)
    );

    const result: SkuDecisionAnalysisResult = {
      stockItemId,
      sku: stockItem.sku,
      productName: stockItem.name,
      categoryName: stockItem.product.category?.name || null,
      inventory: {
        onHand,
        reserved,
        available,
        minStockLevel: stockItem.minStockLevel,
        maxStockLevel: stockItem.maxStockLevel,
      },
      dataStatus,
      historyDays,
      demand,
      coverage: {
        safetyStock: safetyStockResult.safetyStock,
        safetyStockMethod: safetyStockResult.method,
        reorderPoint,
        reorderQuantity,
        daysOfCover,
      },
      risk: {
        stockout: stockoutRisk.score,
        stockoutSeverity: stockoutRisk.severity,
        overstock: overstockRisk.score,
        overstockSeverity: overstockRisk.severity,
        slowMoving: deadStockResult.isSlowMoving,
        deadStock: deadStockResult.isDeadStock,
        deadStockSeverity: deadStockResult.severity,
        daysSinceLastSale,
        daysWithoutSale,
        deadStockCostValue: deadStockResult.costValue,
        deadStockRetailValue: deadStockResult.retailValue,
        unusualDemand,
      },
      confidence,
      pricing: {
        costPrice: Number(stockItem.costPrice),
        sellingPrice: Number(stockItem.sellingPrice),
        minimumPrice,
        expectedMarginPct,
      },
      pricingEvaluation: pricingEval,
      engineConfig: config,
      engineVersion: DECISION_ENGINE_VERSION,
      factors: pricingEval.factors,
      calculatedAt,
    };

    return result;
  }

  /**
   * Retrieves high-level decision overview across store SKUs.
   * Read-only: uses the latest DecisionSnapshot per SKU and evaluates live (without writing) only
   * the SKUs that have no usable snapshot yet.
   */
  async getOverview(
    storeId: number,
    query: {
      riskFilter: 'ALL' | 'STOCKOUT' | 'OVERSTOCK' | 'DEAD_STOCK';
      page: number;
      limit: number;
    }
  ) {
    const stockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true },
      select: { id: true, updatedAt: true },
    });

    const [latestSnapshots, lastMovements, config] = await Promise.all([
      this.findLatestSnapshots(storeId),
      this.prisma.stockMovement.groupBy({
        by: ['stockItemId'],
        where: { storeId },
        _max: { createdAt: true },
      }),
      this.prisma.engineConfig.findUnique({ where: { storeId }, select: { updatedAt: true } }),
    ]);
    const lastMovementAt = new Map(lastMovements.map((row) => [row.stockItemId, row._max.createdAt]));

    const analyses: SkuDecisionAnalysisResult[] = [];
    const freshnessById = new Map<number, DecisionFreshness>();
    for (const item of stockItems) {
      const snapshot = latestSnapshots.get(item.id);
      const fromSnapshot = snapshot ? DecisionEngineService.fromSnapshot(snapshot) : null;
      if (snapshot && fromSnapshot) {
        analyses.push(fromSnapshot);
        freshnessById.set(item.id, {
          stale: isDecisionSnapshotStale(
            snapshot.calculatedAt,
            [item.updatedAt, lastMovementAt.get(item.id), config?.updatedAt],
            new Date(),
            DECISION_SNAPSHOT_MAX_AGE_MS,
            snapshot.version
          ),
          snapshotAt: snapshot.calculatedAt.toISOString(),
          source: 'SNAPSHOT',
        });
        continue;
      }

      try {
        const analyzed = await this.analyzeSku(storeId, item.id, { persist: false });
        analyses.push(analyzed);
        freshnessById.set(item.id, { stale: true, snapshotAt: null, source: 'LIVE' });
      } catch (err) {
        logger.warn('decision_engine_sku_analysis_failed', {
          storeId,
          stockItemId: item.id,
          error: err,
        });
      }
    }

    // Compute Summary Cards
    const totalSkus = analyses.length;
    let stockoutRiskCount = 0;
    let overstockRiskCount = 0;
    let deadStockCount = 0;
    let totalDeadStockCostValue = 0;
    let totalDeadStockRetailValue = 0;

    // Same categories as the alert sync (risk-classification.ts), using each SKU's own config bands.
    const classify = (a: SkuDecisionAnalysisResult) =>
      classifyRisk({
        availableStock: a.inventory.available,
        reorderPoint: a.coverage.reorderPoint,
        stockoutScore: a.risk.stockout,
        overstockScore: a.risk.overstock,
        isDeadStock: a.risk.deadStock,
        highRiskThreshold: a.engineConfig.highRiskThreshold,
      });

    for (const a of analyses) {
      const flags = classify(a);
      if (flags.stockoutRisk) {
        stockoutRiskCount++;
      }
      if (flags.overstockRisk) {
        overstockRiskCount++;
      }
      if (flags.deadStock) {
        deadStockCount++;
        totalDeadStockCostValue += a.risk.deadStockCostValue;
        totalDeadStockRetailValue += a.risk.deadStockRetailValue;
      }
    }

    // Filter list by requested riskFilter
    let filtered = analyses;
    if (query.riskFilter === 'STOCKOUT') {
      filtered = analyses.filter((a) => classify(a).stockoutRisk);
    } else if (query.riskFilter === 'OVERSTOCK') {
      filtered = analyses.filter((a) => classify(a).overstockRisk);
    } else if (query.riskFilter === 'DEAD_STOCK') {
      filtered = analyses.filter((a) => classify(a).deadStock);
    }

    // Pagination
    const total = filtered.length;
    const startIndex = (query.page - 1) * query.limit;
    const pagedItems: SkuDecisionReadModel[] = filtered.slice(startIndex, startIndex + query.limit).map((analysis) => ({
      analysis,
      freshness: freshnessById.get(analysis.stockItemId)!,
    }));

    return {
      summary: {
        totalSkus,
        stockoutRiskCount,
        overstockRiskCount,
        deadStockCount,
        totalDeadStockCostValue: Number(totalDeadStockCostValue.toFixed(2)),
        totalDeadStockRetailValue: Number(totalDeadStockRetailValue.toFixed(2)),
      },
      items: pagedItems,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * Latest snapshot per SKU for a store. MAX(id) is used as "latest" because snapshots are append-only
   * and ids are assigned in insertion order; the (storeId, stockItemId, ...) index covers the scan.
   */
  private async findLatestSnapshots(storeId: number) {
    const rows = await this.prisma.$queryRaw<Array<{ id: number | bigint }>>`
      SELECT MAX(id) AS id FROM decision_snapshots WHERE storeId = ${storeId} GROUP BY stockItemId`;
    const ids = (rows ?? []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
    if (ids.length === 0) {
      return new Map<number, DecisionSnapshot>();
    }

    const snapshots = await this.prisma.decisionSnapshot.findMany({
      where: { storeId, id: { in: ids } },
    });
    return new Map(snapshots.map((snapshot) => [snapshot.stockItemId, snapshot]));
  }

  /** Mean and sample standard deviation (n − 1) of net sold quantity. */
  private static meanAndSampleStdDev(series: Array<{ netSoldQty: number }>): { mean: number; stdDev: number } {
    const n = series.length;
    if (n === 0) {
      return { mean: 0, stdDev: 0 };
    }
    const mean = series.reduce((acc, row) => acc + row.netSoldQty, 0) / n;
    if (n < 2) {
      return { mean, stdDev: 0 };
    }
    const variance = series.reduce((acc, row) => acc + (row.netSoldQty - mean) ** 2, 0) / (n - 1);
    return { mean, stdDev: Math.sqrt(variance) };
  }

  /** Serializes a full analysis into the existing JSON columns (no schema migration needed). */
  static toSnapshotPayload(result: SkuDecisionAnalysisResult) {
    return {
      inputJson: {
        identity: {
          sku: result.sku,
          productName: result.productName,
          categoryName: result.categoryName ?? null,
        },
        pricing: result.pricing,
        inventory: result.inventory,
        config: result.engineConfig as unknown as Prisma.InputJsonObject,
      } as Prisma.InputJsonObject,
      metricsJson: {
        schema: DECISION_SNAPSHOT_SCHEMA_VERSION,
        dataStatus: result.dataStatus,
        historyDays: result.historyDays,
        demand: result.demand as unknown as Prisma.InputJsonObject,
        coverage: result.coverage,
        confidence: result.confidence,
        pricingEvaluation: result.pricingEvaluation as unknown as Prisma.InputJsonObject,
      } as Prisma.InputJsonObject,
      risksJson: result.risk as unknown as Prisma.InputJsonObject,
    };
  }

  /**
   * Rebuilds an analysis from a snapshot written by toSnapshotPayload. Returns null for snapshots of
   * an older JSON shape (e.g. seed data or pre-v2 rows) so callers treat them as missing.
   */
  static fromSnapshot(snapshot: DecisionSnapshot): SkuDecisionAnalysisResult | null {
    const input = snapshot.inputJson as Record<string, any> | null;
    const metrics = snapshot.metricsJson as Record<string, any> | null;
    const risk = snapshot.risksJson as SkuDecisionAnalysisResult['risk'] | null;

    if (!input?.identity || !metrics || metrics.schema !== DECISION_SNAPSHOT_SCHEMA_VERSION || !risk) {
      return null;
    }

    const pricingEvaluation = metrics.pricingEvaluation as PricingEvaluationResult;
    return {
      stockItemId: snapshot.stockItemId,
      sku: input.identity.sku,
      productName: input.identity.productName,
      categoryName: input.identity.categoryName,
      inventory: input.inventory,
      dataStatus: metrics.dataStatus,
      historyDays: metrics.historyDays,
      demand: metrics.demand,
      coverage: metrics.coverage,
      risk,
      confidence: metrics.confidence,
      pricing: input.pricing,
      pricingEvaluation,
      engineConfig: input.config,
      engineVersion: snapshot.version,
      factors: pricingEvaluation.factors,
      calculatedAt: snapshot.calculatedAt.toISOString(),
    };
  }

  /**
   * Batch recalculates daily sales summaries and all SKUs for a store.
   * Bounded: processes at most `limit` SKUs per call in id order. The first page (no afterId) also
   * rebuilds the 90-day summaries; pass the returned nextCursor as afterId to continue.
   * Legacy fields (summariesUpdatedDays, totalSkus, successCount, failureCount) are preserved.
   */
  async recalculateStore(storeId: number, options: { afterId?: number; limit?: number } = {}) {
    let summariesUpdatedDays = 0;
    if (!options.afterId) {
      const todayKey = toBusinessDateKey(new Date());
      const fromDate = businessDateKeyToDate(addBusinessDays(todayKey, -89));
      const today = businessDateKeyToDate(todayKey);

      // 1. Rebuild daily sales summaries
      const summaryResult = await this.dailySalesSummaryService.rebuildDailySalesSummary(storeId, fromDate, today);
      summariesUpdatedDays = summaryResult.updatedDays;
    }

    // 2. Recompute one bounded page of active StockItems
    const [totalSkus, page] = await Promise.all([
      this.prisma.stockItem.count({ where: { storeId, isActive: true } }),
      this.recomputeStorePage(storeId, options),
    ]);

    return {
      storeId,
      summariesUpdatedDays,
      totalSkus,
      successCount: page.processed - page.failedStockItemIds.length,
      failureCount: page.failedStockItemIds.length,
      processed: page.processed,
      failedStockItemIds: page.failedStockItemIds,
      remaining: page.remaining,
      nextCursor: page.nextCursor,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Recomputes up to `limit` active SKUs with id > afterId (keyset pagination, stable under inserts).
   * Failures are logged per SKU and never abort the page.
   */
  async recomputeStorePage(
    storeId: number,
    options: { afterId?: number; limit?: number } = {}
  ): Promise<{ processed: number; failedStockItemIds: number[]; remaining: number; nextCursor: number | null }> {
    const limit = Math.max(1, Math.min(options.limit ?? env.DECISION_RECALCULATE_MAX_SKUS, env.DECISION_RECALCULATE_MAX_SKUS));
    const afterId = options.afterId ?? 0;

    const stockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true, id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });

    const failedStockItemIds: number[] = [];
    for (const item of stockItems) {
      try {
        await this.recomputeSku(storeId, item.id);
      } catch (err) {
        failedStockItemIds.push(item.id);
        logger.warn('decision_engine_recompute_failed', { storeId, stockItemId: item.id, error: err });
      }
    }

    const lastId = stockItems.length > 0 ? stockItems[stockItems.length - 1].id : afterId;
    const remaining =
      stockItems.length < limit
        ? 0
        : await this.prisma.stockItem.count({ where: { storeId, isActive: true, id: { gt: lastId } } });

    return {
      processed: stockItems.length,
      failedStockItemIds,
      remaining,
      nextCursor: remaining > 0 ? lastId : null,
    };
  }

  private async getHistoryFacts(db: DecisionDbClient, storeId: number, stockItemId: number): Promise<{
    earliestActualHistoryAt: Date | null;
    latestActualSaleAt: Date | null;
    firstStockedAt: Date | null;
  }> {
    const [earliestNative, latestNative, earliestHistorical, latestHistorical, firstStockIn] = await Promise.all([
      db.order.findFirst({
        where: {
          storeId,
          status: 'FULFILLED',
          fulfilledAt: { not: null },
          items: { some: { stockItemId, storeId } },
        },
        orderBy: { fulfilledAt: 'asc' },
        select: { fulfilledAt: true },
      }),
      db.order.findFirst({
        where: {
          storeId,
          status: 'FULFILLED',
          fulfilledAt: { not: null },
          items: { some: { stockItemId, storeId } },
        },
        orderBy: { fulfilledAt: 'desc' },
        select: { fulfilledAt: true },
      }),
      db.historicalSale.findFirst({
        where: { storeId, stockItemId },
        orderBy: { soldAt: 'asc' },
        select: { soldAt: true },
      }),
      db.historicalSale.findFirst({
        where: { storeId, stockItemId },
        orderBy: { soldAt: 'desc' },
        select: { soldAt: true },
      }),
      db.stockMovement.findFirst({
        where: { storeId, stockItemId, delta: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const earliestDates = [earliestNative?.fulfilledAt, earliestHistorical?.soldAt].filter(
      (date): date is Date => Boolean(date)
    );
    const latestDates = [latestNative?.fulfilledAt, latestHistorical?.soldAt].filter(
      (date): date is Date => Boolean(date)
    );

    return {
      earliestActualHistoryAt:
        earliestDates.length > 0
          ? new Date(Math.min(...earliestDates.map((date) => date.getTime())))
          : null,
      latestActualSaleAt:
        latestDates.length > 0
          ? new Date(Math.max(...latestDates.map((date) => date.getTime())))
          : null,
      firstStockedAt: firstStockIn?.createdAt ?? null,
    };
  }
}
