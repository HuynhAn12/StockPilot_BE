import { PrismaClient, Prisma, RecommendationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { DemandTrend } from '../decision-engine/demand-metrics.service';
import { DEFAULT_ENGINE_CONFIG } from '../decision-engine/engine-config.service';
import { DecisionDataStatus, PricingEvaluator, PricingEvaluationResult } from '../decision-engine/pricing-evaluator';
import { AuditLogService } from '../../common/services/audit-log.service';
import { BusinessSyncService } from '../../common/services/business-sync.service';

export interface PricingEvaluationInput {
  storeId: number;
  stockItemId: number;
  sellingPrice: number;
  costPrice: number;
  minimumMarginPct: number;
  maxMarkdownPct: number;
  maxMarkupPct: number;
  daysSinceLastSale: number | null;
  daysOfCover: number | null;
  overstockScore: number;
  stockoutScore: number;
  trend: DemandTrend;
  confidenceScore: number;
  engineVersion?: string;
  slowMovingDays?: number;
  deadStockDays?: number;
  dataStatus?: DecisionDataStatus;
}

export class PricingService {
  private readonly evaluator: PricingEvaluator;

  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    evaluator?: PricingEvaluator
  ) {
    this.evaluator = evaluator ?? new PricingEvaluator();
  }

  /**
   * Evaluates if a pricing recommendation should be generated for a SKU and syncs with DB.
   * Opens its own transaction and serializes on the StockItem row.
   */
  async evaluatePricingRecommendation(input: PricingEvaluationInput): Promise<PricingEvaluationResult> {
    const evaluation = this.evaluate(input);

    await this.prisma.$transaction(async (tx) => {
      await this.lockStockItem(tx, input.storeId, input.stockItemId);
      await this.syncRecommendationInTransaction(tx, input, evaluation);
    });

    return evaluation;
  }

  /**
   * Same as evaluatePricingRecommendation but runs inside the caller's transaction. The caller must
   * already hold the StockItem row lock (DecisionEngineService.recomputeSku does). A precomputed
   * evaluation can be passed so the persisted recommendation matches the analysis exactly.
   */
  async syncRecommendationInTransaction(
    tx: Prisma.TransactionClient,
    input: PricingEvaluationInput,
    precomputed?: PricingEvaluationResult
  ): Promise<PricingEvaluationResult> {
    const evaluation = precomputed ?? this.evaluate(input);

    if (evaluation.shouldGenerateRecommendation) {
      await this.upsertPendingRecommendation(tx, input, evaluation);
    } else {
      // The engine no longer recommends a change (MAINTAIN, low confidence, insufficient data):
      // a still-PENDING recommendation is obsolete and must not be acceptable.
      await PricingService.expirePendingRecommendations(tx, input.storeId, [input.stockItemId]);
    }

    return evaluation;
  }

  /**
   * Marks PENDING recommendations of the given SKUs as EXPIRED. Call inside the transaction that
   * changes their selling or cost price, so a recommendation computed on the old basis can never be
   * accepted afterwards.
   */
  static async expirePendingRecommendations(
    tx: Prisma.TransactionClient,
    storeId: number,
    stockItemIds: number[]
  ): Promise<number> {
    if (stockItemIds.length === 0) {
      return 0;
    }
    const result = await tx.pricingRecommendation.updateMany({
      where: { storeId, stockItemId: { in: stockItemIds }, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  private evaluate(input: PricingEvaluationInput): PricingEvaluationResult {
    return this.evaluator.evaluatePricing({
      sellingPrice: input.sellingPrice,
      costPrice: input.costPrice,
      minimumMarginPct: input.minimumMarginPct,
      maxMarkdownPct: input.maxMarkdownPct,
      maxMarkupPct: input.maxMarkupPct,
      daysSinceLastSale: input.daysSinceLastSale,
      daysOfCover: input.daysOfCover,
      overstockScore: input.overstockScore,
      stockoutScore: input.stockoutScore,
      trend: input.trend,
      confidenceScore: input.confidenceScore,
      slowMovingDays: input.slowMovingDays,
      deadStockDays: input.deadStockDays,
      dataStatus: input.dataStatus,
    });
  }

  /** Keeps at most one PENDING recommendation per SKU: refreshes the existing one or creates it. */
  private async upsertPendingRecommendation(
    tx: Prisma.TransactionClient,
    input: PricingEvaluationInput,
    evaluation: PricingEvaluationResult
  ) {
    const {
      storeId,
      stockItemId,
      sellingPrice,
      costPrice,
      overstockScore,
      stockoutScore,
      confidenceScore,
      engineVersion = 'DECISION_ENGINE_V1',
    } = input;

    const reasonJson = {
      sellingPrice,
      costPrice,
      minimumPrice: evaluation.minimumPrice,
      expectedMarginPct: evaluation.expectedMarginPct,
      discountPct: evaluation.discountPct,
      action: evaluation.action,
      factors: evaluation.factors,
    };

    const existing = await tx.pricingRecommendation.findFirst({
      where: {
        storeId,
        stockItemId,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      currentPrice: new Prisma.Decimal(sellingPrice),
      recommendedPrice: new Prisma.Decimal(evaluation.recommendedPrice),
      discountPct: new Prisma.Decimal(evaluation.discountPct),
      action: evaluation.action,
      riskScore: new Prisma.Decimal(Math.max(overstockScore, stockoutScore)),
      confidence: new Prisma.Decimal(confidenceScore),
      reasonJson: reasonJson as Prisma.InputJsonValue,
      engineVersion,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    };

    if (existing) {
      await tx.pricingRecommendation.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await tx.pricingRecommendation.create({
        data: {
          storeId,
          stockItemId,
          ...data,
          status: 'PENDING',
        },
      });
    }
  }

  async listRecommendations(
    storeId: number,
    query: {
      status?: RecommendationStatus;
      stockItemId?: number;
      page: number;
      limit: number;
    }
  ) {
    const where: Prisma.PricingRecommendationWhereInput = {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.pricingRecommendation.count({ where }),
      this.prisma.pricingRecommendation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          stockItem: {
            select: {
              id: true,
              sku: true,
              name: true,
              costPrice: true,
              sellingPrice: true,
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          decidedBy: {
            select: {
              id: true,
              email: true,
              fullName: true,
            },
          },
        },
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async listPriceHistories(storeId: number) {
    return this.prisma.priceHistory.findMany({
      where: { storeId },
      orderBy: { changedAt: 'desc' },
      take: 50,
      include: {
        stockItem: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
        changedBy: {
          select: {
            id: true,
            email: true,
            fullName: true,
          },
        },
      },
    });
  }

  async acceptRecommendation(storeId: number, userId: number, recommendationId: number, applyToStockItem = true) {
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.getPendingRecommendationForDecision(tx, storeId, recommendationId);
      const stockItem = await this.assertStockPriceNotStale(tx, storeId, rec.stockItemId, rec.currentPrice);
      await this.assertRecommendationStillValid(tx, storeId, rec, stockItem);

      const oldPrice = rec.stockItem.sellingPrice;
      const newPrice = rec.recommendedPrice;

      const updated = await tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'ACCEPTED',
          finalUserSelectedPrice: newPrice,
          decidedById: userId,
          decidedAt: new Date(),
        },
      });

      if (applyToStockItem) {
        await tx.stockItem.update({
          where: { id: rec.stockItemId },
          data: { sellingPrice: newPrice },
        });

        await tx.priceHistory.create({
          data: {
            storeId,
            stockItemId: rec.stockItemId,
            oldPrice,
            newPrice,
            source: 'RECOMMENDATION_ACCEPT',
            recommendationId: rec.id,
            changedById: userId,
            reason: `Accepted pricing recommendation (${rec.action})`,
          },
        });
      }

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'PRICING_RECOMMENDATION_APPROVED',
        entityType: 'PRICING_RECOMMENDATION',
        entityId: rec.id,
        beforeJson: {
          status: rec.status,
          currentPrice: rec.currentPrice,
          recommendedPrice: rec.recommendedPrice,
          stockItemSellingPrice: oldPrice,
        },
        afterJson: {
          status: updated.status,
          finalUserSelectedPrice: updated.finalUserSelectedPrice,
          applyToStockItem,
          stockItemId: rec.stockItemId,
          oldPrice,
          newPrice,
        },
      });

      return updated;
    }).then((result) => {
      if (applyToStockItem) {
        BusinessSyncService.getInstance(this.prisma)
          .syncAfterPriceChange(storeId, result.stockItemId)
          .catch(() => {});
      }
      return result;
    });
  }

  async rejectRecommendation(storeId: number, userId: number, recommendationId: number, _reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.getPendingRecommendationForDecision(tx, storeId, recommendationId);

      const updated = await tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'REJECTED',
          decidedById: userId,
          decidedAt: new Date(),
        },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'PRICING_RECOMMENDATION_REJECTED',
        entityType: 'PRICING_RECOMMENDATION',
        entityId: rec.id,
        beforeJson: {
          status: rec.status,
          currentPrice: rec.currentPrice,
          recommendedPrice: rec.recommendedPrice,
        },
        afterJson: {
          status: updated.status,
          stockItemId: rec.stockItemId,
        },
      });

      return updated;
    });
  }

  async modifyRecommendation(
    storeId: number,
    userId: number,
    recommendationId: number,
    customPrice: number,
    applyToStockItem = true
  ) {
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.getPendingRecommendationForDecision(tx, storeId, recommendationId);
      await this.assertStockPriceNotStale(tx, storeId, rec.stockItemId, rec.currentPrice);

      const minimumMarginPct = await this.getMinimumMarginPct(tx, storeId);
      const minimumPrice = PricingEvaluator.calculateMinimumPrice(Number(rec.stockItem.costPrice), minimumMarginPct);
      if (customPrice < minimumPrice) {
        throw new ValidationError(
          `Custom price ${customPrice.toLocaleString()} is below minimum margin floor ${minimumPrice.toLocaleString()}`
        );
      }

      const oldPrice = rec.stockItem.sellingPrice;
      const newPrice = new Prisma.Decimal(customPrice);

      const updated = await tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'MODIFIED',
          finalUserSelectedPrice: newPrice,
          decidedById: userId,
          decidedAt: new Date(),
        },
      });

      if (applyToStockItem) {
        await tx.stockItem.update({
          where: { id: rec.stockItemId },
          data: { sellingPrice: newPrice },
        });

        await tx.priceHistory.create({
          data: {
            storeId,
            stockItemId: rec.stockItemId,
            oldPrice,
            newPrice,
            source: 'RECOMMENDATION_MODIFY',
            recommendationId: rec.id,
            changedById: userId,
            reason: `Owner modified pricing recommendation to ${customPrice.toLocaleString()}`,
          },
        });
      }

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'PRICING_RECOMMENDATION_MODIFIED',
        entityType: 'PRICING_RECOMMENDATION',
        entityId: rec.id,
        beforeJson: {
          status: rec.status,
          currentPrice: rec.currentPrice,
          recommendedPrice: rec.recommendedPrice,
          stockItemSellingPrice: oldPrice,
        },
        afterJson: {
          status: updated.status,
          finalUserSelectedPrice: updated.finalUserSelectedPrice,
          applyToStockItem,
          stockItemId: rec.stockItemId,
          oldPrice,
          newPrice,
        },
      });

      return updated;
    }).then((result) => {
      if (applyToStockItem) {
        BusinessSyncService.getInstance(this.prisma)
          .syncAfterPriceChange(storeId, result.stockItemId)
          .catch(() => {});
      }
      return result;
    });
  }

  async getPriceHistories(storeId: number, stockItemId?: number, limit = 50) {
    return this.prisma.priceHistory.findMany({
      where: {
        storeId,
        ...(stockItemId ? { stockItemId } : {}),
      },
      orderBy: { changedAt: 'desc' },
      take: limit,
      include: {
        changedBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        stockItem: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
      },
    });
  }

  private async getPendingRecommendationForDecision(
    tx: Prisma.TransactionClient,
    storeId: number,
    recommendationId: number
  ) {
    // Lock only rows owned by the caller's store so a foreign id can neither be read nor locked.
    await tx.$queryRaw`SELECT id FROM pricing_recommendations WHERE id = ${recommendationId} AND storeId = ${storeId} FOR UPDATE`;

    const rec = await tx.pricingRecommendation.findFirst({
      where: { id: recommendationId, storeId },
      include: { stockItem: true },
    });

    if (!rec) {
      throw new NotFoundError('Pricing recommendation not found');
    }

    if (rec.status !== 'PENDING') {
      throw new ConflictError(`Pricing recommendation is already ${rec.status}`);
    }

    if (rec.expiresAt && rec.expiresAt <= new Date()) {
      throw new ConflictError('PRICING_RECOMMENDATION_EXPIRED');
    }

    return rec;
  }

  private async assertStockPriceNotStale(
    tx: Prisma.TransactionClient,
    storeId: number,
    stockItemId: number,
    recommendationCurrentPrice: Prisma.Decimal
  ) {
    const stockItem = await this.lockStockItem(tx, storeId, stockItemId);
    if (!new Prisma.Decimal(stockItem.sellingPrice).equals(new Prisma.Decimal(recommendationCurrentPrice))) {
      throw new ConflictError('STALE_PRICING_RECOMMENDATION');
    }
    return stockItem;
  }

  /**
   * Revalidates a recommendation against the CURRENT cost basis before it is applied:
   * - the cost price must equal the one the engine used (recorded in reasonJson.costPrice);
   * - the recommended price must still respect the minimum-margin floor from the current config.
   * Recommendations created before costPrice was recorded skip only the first check.
   */
  private async assertRecommendationStillValid(
    tx: Prisma.TransactionClient,
    storeId: number,
    rec: { recommendedPrice: Prisma.Decimal; reasonJson: Prisma.JsonValue },
    stockItem: { costPrice: Prisma.Decimal | number }
  ) {
    const recordedCost = (rec.reasonJson as { costPrice?: unknown } | null)?.costPrice;
    if (typeof recordedCost === 'number' && !new Prisma.Decimal(stockItem.costPrice).equals(new Prisma.Decimal(recordedCost))) {
      throw new ConflictError('STALE_PRICING_RECOMMENDATION_COST_CHANGED');
    }

    const minimumMarginPct = await this.getMinimumMarginPct(tx, storeId);
    const minimumPrice = PricingEvaluator.calculateMinimumPrice(Number(stockItem.costPrice), minimumMarginPct);
    if (Number(rec.recommendedPrice) < minimumPrice) {
      throw new ConflictError('PRICING_RECOMMENDATION_BELOW_FLOOR', { minimumPrice });
    }
  }

  private async lockStockItem(tx: Prisma.TransactionClient, storeId: number, stockItemId: number) {
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${stockItemId} AND storeId = ${storeId} FOR UPDATE`;

    const stockItem = await tx.stockItem.findFirst({
      where: { id: stockItemId, storeId },
    });

    if (!stockItem) {
      throw new NotFoundError('StockItem not found');
    }

    return stockItem;
  }

  private async getMinimumMarginPct(tx: Prisma.TransactionClient, storeId: number): Promise<number> {
    const config = await tx.engineConfig.findUnique({
      where: { storeId },
      select: { minimumMarginPct: true },
    });

    return config ? Number(config.minimumMarginPct) : DEFAULT_ENGINE_CONFIG.minimumMarginPct;
  }
}
