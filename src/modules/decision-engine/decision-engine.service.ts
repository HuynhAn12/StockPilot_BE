import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { DailySalesSummaryService } from '../daily-sales-summary/daily-sales-summary.service';
import { EngineConfigService, ResolvedEngineConfig } from './engine-config.service';
import { DemandMetricsService, DemandMetricsResult } from './demand-metrics.service';
import { RiskEvaluator, SafetyStockResult } from './risk-evaluator';
import { PricingEvaluator, PricingEvaluationResult } from './pricing-evaluator';
import { AlertService } from '../alerts/alert.service';
import { PricingService } from '../pricing/pricing.service';

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
  demand: DemandMetricsResult;
  coverage: {
    safetyStock: number;
    safetyStockMethod: string;
    reorderPoint: number;
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
   * Deterministically analyzes a single SKU, updates alerts and pricing recommendations, and persists a snapshot.
   */
  async analyzeSku(storeId: number, stockItemId: number): Promise<SkuDecisionAnalysisResult> {
    const stockItem = await this.prisma.stockItem.findUnique({
      where: { id: stockItemId },
      include: {
        product: {
          include: { category: true },
        },
        balances: true,
      },
    });

    if (!stockItem || stockItem.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy mặt hàng (StockItem)');
    }

    // 1. Calculate Inventory Balances
    const onHand = stockItem.balances.reduce((acc, b) => acc + b.quantity, 0);
    const reserved = stockItem.balances.reduce((acc, b) => acc + b.reservedQuantity, 0);
    const available = Math.max(0, onHand - reserved);

    // 2. Extract 90-day time series from DailySalesSummary
    const series90 = await this.dailySalesSummaryService.getDailySeries(storeId, stockItemId, 90);

    // 3. Compute Demand Metrics
    const demand = this.demandMetricsService.calculateDemandMetrics(series90);

    // 4. Compute Days Since Last Sale
    let daysSinceLastSale: number | null = null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Search backwards in series90 for last sale
    for (let i = series90.length - 1; i >= 0; i--) {
      if (series90[i].netSoldQty > 0) {
        const lastSaleDate = new Date(series90[i].summaryDate + 'T00:00:00.000Z');
        const diffDays = Math.floor((today.getTime() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24));
        daysSinceLastSale = Math.max(0, diffDays);
        break;
      }
    }

    // If not found in 90 days, query database for older orders or historical sales
    if (daysSinceLastSale === null) {
      const [latestOrderItem, latestHistoricalSale] = await Promise.all([
        this.prisma.orderItem.findFirst({
          where: {
            stockItemId,
            order: { status: 'FULFILLED' },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        this.prisma.historicalSale.findFirst({
          where: { stockItemId },
          orderBy: { soldAt: 'desc' },
          select: { soldAt: true },
        }),
      ]);

      const lastDates: Date[] = [];
      if (latestOrderItem) lastDates.push(latestOrderItem.createdAt);
      if (latestHistoricalSale) lastDates.push(latestHistoricalSale.soldAt);

      if (lastDates.length > 0) {
        lastDates.sort((a, b) => b.getTime() - a.getTime());
        const latestDate = lastDates[0];
        daysSinceLastSale = Math.max(
          0,
          Math.floor((today.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24))
        );
      }
    }

    // 5. Get Engine Config
    const config = await this.engineConfigService.getConfig(storeId);

    // 6. Compute Confidence
    const confidence = this.riskEvaluator.calculateConfidence(
      series90.length,
      config.minimumHistoryDays,
      demand.daysWithSales90
    );

    // 7. Compute Safety Stock, Reorder Point, Days of Cover
    const hasSufficientHistory = confidence.level !== 'LOW' && (demand.daysWithSales90 >= 5 || demand.totalSold90 > 0);
    const safetyStockResult: SafetyStockResult = this.riskEvaluator.calculateSafetyStock({
      stdDev30: demand.stdDev30,
      leadTimeDays: config.leadTimeDays,
      serviceLevel: config.serviceLevel,
      avg30: demand.avg30,
      safetyDays: config.safetyDays,
      hasSufficientHistory,
    });

    const reorderPoint = this.riskEvaluator.calculateReorderPoint(
      demand.avg30,
      config.leadTimeDays,
      safetyStockResult.safetyStock
    );

    const daysOfCover = this.riskEvaluator.calculateDaysOfCover(available, demand.avg30);

    // 8. Compute Risk Scores
    const stockoutRisk = this.riskEvaluator.calculateStockoutRisk({
      availableStock: available,
      reorderPoint,
      daysOfCover,
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      trendRatio: demand.trendRatio,
      lowThreshold: config.lowRiskThreshold,
      highThreshold: config.highRiskThreshold,
      criticalThreshold: config.criticalRiskThreshold,
    });

    const overstockRisk = this.riskEvaluator.calculateOverstockRisk({
      availableStock: available,
      maxStockLevel: stockItem.maxStockLevel,
      daysOfCover,
      targetCoverageDays: config.targetCoverageDays,
      trendRatio: demand.trendRatio,
      lowThreshold: config.lowRiskThreshold,
      highThreshold: config.highRiskThreshold,
      criticalThreshold: config.criticalRiskThreshold,
    });

    const deadStockResult = this.riskEvaluator.evaluateSlowAndDeadStock({
      availableStock: available,
      daysSinceLastSale,
      slowMovingDays: config.slowMovingDays,
      deadStockDays: config.deadStockDays,
      costPrice: Number(stockItem.costPrice),
      sellingPrice: Number(stockItem.sellingPrice),
    });

    // Unusual demand (using recent 3 days vs 30-day baseline)
    const recent3Series = series90.slice(Math.max(0, series90.length - 3));
    const unusualDemand = this.riskEvaluator.detectUnusualDemand(
      recent3Series,
      demand.avg30,
      demand.stdDev30
    );

    // 9. Sync Alerts
    await this.alertService.syncAlertsForSku({
      storeId,
      stockItemId,
      sku: stockItem.sku,
      productName: stockItem.name,
      availableStock: available,
      reorderPoint,
      stockoutScore: stockoutRisk.score,
      stockoutSeverity: stockoutRisk.severity,
      overstockScore: overstockRisk.score,
      overstockSeverity: overstockRisk.severity,
      isSlowMoving: deadStockResult.isSlowMoving,
      isDeadStock: deadStockResult.isDeadStock,
      deadStockSeverity: deadStockResult.severity,
      daysSinceLastSale,
      confidenceScore: confidence.score,
      engineVersion: config.engineVersion,
      unusualDemand,
    });

    // 10. Sync Pricing Recommendations
    const pricingEval = await this.pricingService.evaluatePricingRecommendation({
      storeId,
      stockItemId,
      sellingPrice: Number(stockItem.sellingPrice),
      costPrice: Number(stockItem.costPrice),
      minimumMarginPct: config.minimumMarginPct,
      maxMarkdownPct: config.maxMarkdownPct,
      maxMarkupPct: config.maxMarkupPct,
      daysSinceLastSale,
      daysOfCover,
      overstockScore: overstockRisk.score,
      stockoutScore: stockoutRisk.score,
      trend: demand.trend,
      confidenceScore: confidence.score,
      engineVersion: config.engineVersion,
    });

    const calculatedAt = new Date().toISOString();
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
      demand,
      coverage: {
        safetyStock: safetyStockResult.safetyStock,
        safetyStockMethod: safetyStockResult.method,
        reorderPoint,
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
      engineVersion: config.engineVersion,
      factors: pricingEval.factors,
      calculatedAt,
    };

    // 11. Persist Decision Snapshot
    await this.prisma.decisionSnapshot.create({
      data: {
        storeId,
        stockItemId,
        calculatedAt: new Date(calculatedAt),
        inputJson: {
          pricing: result.pricing,
          inventory: result.inventory,
          config: result.engineConfig as unknown as Prisma.InputJsonObject,
        } as Prisma.InputJsonObject,
        metricsJson: {
          demand: result.demand as unknown as Prisma.InputJsonObject,
          coverage: result.coverage,
          confidence: result.confidence,
        } as Prisma.InputJsonObject,
        risksJson: result.risk as unknown as Prisma.InputJsonObject,
        version: config.engineVersion,
      },
    });

    return result;
  }

  /**
   * Retrieves high-level decision overview across store SKUs.
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
      select: { id: true },
    });

    const analyses: SkuDecisionAnalysisResult[] = [];
    for (const item of stockItems) {
      try {
        const analyzed = await this.analyzeSku(storeId, item.id);
        analyses.push(analyzed);
      } catch (err) {
        console.error(`Failed to analyze SKU ${item.id}:`, err);
      }
    }

    // Compute Summary Cards
    const totalSkus = analyses.length;
    let stockoutRiskCount = 0;
    let overstockRiskCount = 0;
    let deadStockCount = 0;
    let totalDeadStockCostValue = 0;
    let totalDeadStockRetailValue = 0;

    for (const a of analyses) {
      if (a.risk.stockout >= 50 || a.inventory.available <= 0) {
        stockoutRiskCount++;
      }
      if (a.risk.overstock >= 50) {
        overstockRiskCount++;
      }
      if (a.risk.deadStock) {
        deadStockCount++;
        totalDeadStockCostValue += a.risk.deadStockCostValue;
        totalDeadStockRetailValue += a.risk.deadStockRetailValue;
      }
    }

    // Filter list by requested riskFilter
    let filtered = analyses;
    if (query.riskFilter === 'STOCKOUT') {
      filtered = analyses.filter((a) => a.risk.stockout >= 50 || a.inventory.available <= 0);
    } else if (query.riskFilter === 'OVERSTOCK') {
      filtered = analyses.filter((a) => a.risk.overstock >= 50);
    } else if (query.riskFilter === 'DEAD_STOCK') {
      filtered = analyses.filter((a) => a.risk.deadStock);
    }

    // Pagination
    const total = filtered.length;
    const startIndex = (query.page - 1) * query.limit;
    const pagedItems = filtered.slice(startIndex, startIndex + query.limit);

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
   * Batch recalculates daily sales summaries and all SKUs for a store.
   */
  async recalculateStore(storeId: number) {
    const today = new Date();
    const fromDate = new Date();
    fromDate.setUTCDate(today.getUTCDate() - 90);

    // 1. Rebuild daily sales summaries
    const summaryResult = await this.dailySalesSummaryService.rebuildDailySalesSummary(storeId, fromDate, today);

    // 2. Fetch active StockItems
    const stockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true },
      select: { id: true },
    });

    let successCount = 0;
    let failureCount = 0;

    for (const item of stockItems) {
      try {
        await this.analyzeSku(storeId, item.id);
        successCount++;
      } catch (err) {
        failureCount++;
      }
    }

    return {
      storeId,
      summariesUpdatedDays: summaryResult.updatedDays,
      totalSkus: stockItems.length,
      successCount,
      failureCount,
      completedAt: new Date().toISOString(),
    };
  }
}
