import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { DailyMetricsService } from '../daily-metrics/daily-metrics.service';
import { PolicyService, ResolvedStockPolicy } from './policy.service';
import { DemandService, DemandMetricsResult } from './demand.service';
import { RiskService, SafetyStockResult } from './risk.service';
import { AlertService } from '../alerts/alert.service';
import { PricingService } from '../pricing/pricing.service';

export interface SkuDecisionAnalysisResult {
  stockItemId: number;
  sku: string;
  productName: string;
  categoryName?: string | null;
  pricing: {
    costPrice: number;
    sellingPrice: number;
  };
  inventory: {
    onHand: number;
    reserved: number;
    available: number;
    minStockLevel: number;
    maxStockLevel: number;
  };
  demand: DemandMetricsResult;
  policy: ResolvedStockPolicy;
  metrics: {
    safetyStock: number;
    safetyStockMethod: string;
    reorderPoint: number;
    daysOfInventory: number | null;
  };
  risks: {
    stockoutScore: number;
    stockoutSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    overstockScore: number;
    overstockSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    isDeadStock: boolean;
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
  calculatedAt: string;
}

export class DecisionEngineService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly dailyMetricsService: DailyMetricsService = new DailyMetricsService(prisma),
    private readonly policyService: PolicyService = new PolicyService(prisma),
    private readonly demandService: DemandService = new DemandService(),
    private readonly riskService: RiskService = new RiskService(),
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

    // 2. Extract 90-day time series from DailySkuMetric
    const series90 = await this.dailyMetricsService.getDailySeries(storeId, stockItemId, 90);

    // 3. Compute Demand Metrics
    const demand = this.demandService.calculateDemandMetrics(series90);

    // 4. Compute Days Since Last Sale
    let daysSinceLastSale: number | null = null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Search backwards in series90 for last sale
    for (let i = series90.length - 1; i >= 0; i--) {
      if (series90[i].netSoldQty > 0) {
        const lastSaleDate = new Date(series90[i].metricDate + 'T00:00:00.000Z');
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

    // 5. Get Inventory Policy
    const policy = await this.policyService.getPolicy(storeId, stockItemId);

    // 6. Compute Safety Stock and Reorder Point
    const hasSufficientHistory = demand.daysWithSales90 >= 5 || demand.totalSold90 > 0;
    const safetyStockResult: SafetyStockResult = this.riskService.calculateSafetyStock({
      stdDev30: demand.stdDev30,
      leadTimeDays: policy.leadTimeDays,
      serviceLevel: policy.serviceLevel,
      avg30: demand.avg30,
      safetyDays: policy.safetyDays,
      hasSufficientHistory,
    });

    const reorderPoint = this.riskService.calculateReorderPoint(
      demand.avg30,
      policy.leadTimeDays,
      safetyStockResult.safetyStock
    );

    const daysOfInventory = this.riskService.calculateDaysOfInventory(available, demand.avg30);

    // 7. Compute Risk Scores
    const stockoutRisk = this.riskService.calculateStockoutRisk({
      availableStock: available,
      reorderPoint,
      daysOfInventory,
      leadTimeDays: policy.leadTimeDays,
      safetyDays: policy.safetyDays,
      trendRatio: demand.trendRatio,
    });

    const overstockRisk = this.riskService.calculateOverstockRisk({
      availableStock: available,
      maxStockLevel: stockItem.maxStockLevel,
      daysOfInventory,
      targetCoverageDays: policy.targetCoverageDays,
      trendRatio: demand.trendRatio,
    });

    const deadStockResult = this.riskService.evaluateDeadStock({
      availableStock: available,
      daysSinceLastSale,
      configuredDeadStockDays: policy.deadStockDays,
      costPrice: Number(stockItem.costPrice),
      sellingPrice: Number(stockItem.sellingPrice),
    });

    // Unusual demand (using recent 3 days vs 30-day baseline)
    const recent3Series = series90.slice(Math.max(0, series90.length - 3));
    const unusualDemand = this.riskService.detectUnusualDemand(
      recent3Series,
      demand.avg30,
      demand.stdDev30
    );

    // 8. Sync Smart Alerts
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
      isDeadStock: deadStockResult.isDeadStock,
      deadStockSeverity: deadStockResult.severity,
      daysSinceLastSale,
      unusualDemand,
    });

    // 9. Sync Pricing Recommendations
    await this.pricingService.evaluatePricingRecommendation({
      storeId,
      stockItemId,
      sellingPrice: Number(stockItem.sellingPrice),
      costPrice: Number(stockItem.costPrice),
      minimumMarginPct: policy.minimumMarginPct,
      daysSinceLastSale,
      daysOfInventory,
      overstockScore: overstockRisk.score,
      trend: demand.trend,
    });

    const calculatedAt = new Date().toISOString();

    const result: SkuDecisionAnalysisResult = {
      stockItemId,
      sku: stockItem.sku,
      productName: stockItem.name,
      categoryName: stockItem.product.category?.name || null,
      pricing: {
        costPrice: Number(stockItem.costPrice),
        sellingPrice: Number(stockItem.sellingPrice),
      },
      inventory: {
        onHand,
        reserved,
        available,
        minStockLevel: stockItem.minStockLevel,
        maxStockLevel: stockItem.maxStockLevel,
      },
      demand,
      policy,
      metrics: {
        safetyStock: safetyStockResult.safetyStock,
        safetyStockMethod: safetyStockResult.method,
        reorderPoint,
        daysOfInventory,
      },
      risks: {
        stockoutScore: stockoutRisk.score,
        stockoutSeverity: stockoutRisk.severity,
        overstockScore: overstockRisk.score,
        overstockSeverity: overstockRisk.severity,
        isDeadStock: deadStockResult.isDeadStock,
        deadStockSeverity: deadStockResult.severity,
        daysSinceLastSale,
        deadStockCostValue: deadStockResult.costValue,
        deadStockRetailValue: deadStockResult.retailValue,
        unusualDemand,
      },
      calculatedAt,
    };

    // 10. Persist Decision Snapshot
    await this.prisma.decisionSnapshot.create({
      data: {
        storeId,
        stockItemId,
        calculatedAt: new Date(calculatedAt),
        inputJson: {
          pricing: result.pricing,
          inventory: result.inventory,
          policy: result.policy as unknown as Prisma.InputJsonObject,
        } as Prisma.InputJsonObject,
        metricsJson: {
          demand: result.demand as unknown as Prisma.InputJsonObject,
          metrics: result.metrics,
        } as Prisma.InputJsonObject,
        risksJson: result.risks as unknown as Prisma.InputJsonObject,
        version: 'DECISION_ENGINE_V1',
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
      if (a.risks.stockoutScore >= 50 || a.inventory.available <= 0) {
        stockoutRiskCount++;
      }
      if (a.risks.overstockScore >= 50) {
        overstockRiskCount++;
      }
      if (a.risks.isDeadStock) {
        deadStockCount++;
        totalDeadStockCostValue += a.risks.deadStockCostValue;
        totalDeadStockRetailValue += a.risks.deadStockRetailValue;
      }
    }

    // Filter list by requested riskFilter
    let filtered = analyses;
    if (query.riskFilter === 'STOCKOUT') {
      filtered = analyses.filter((a) => a.risks.stockoutScore >= 50 || a.inventory.available <= 0);
    } else if (query.riskFilter === 'OVERSTOCK') {
      filtered = analyses.filter((a) => a.risks.overstockScore >= 50);
    } else if (query.riskFilter === 'DEAD_STOCK') {
      filtered = analyses.filter((a) => a.risks.isDeadStock);
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
   * Batch recalculates daily metrics and all SKUs for a store.
   */
  async recalculateStore(storeId: number) {
    const today = new Date();
    const fromDate = new Date();
    fromDate.setUTCDate(today.getUTCDate() - 90);

    // 1. Rebuild daily metrics
    const metricsResult = await this.dailyMetricsService.rebuildDailyMetrics(storeId, fromDate, today);

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
      metricsUpdatedDays: metricsResult.updatedDays,
      totalSkus: stockItems.length,
      successCount,
      failureCount,
      completedAt: new Date().toISOString(),
    };
  }
}
