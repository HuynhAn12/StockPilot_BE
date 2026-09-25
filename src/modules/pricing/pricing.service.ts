import { PrismaClient, Prisma, RecommendationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { DemandTrend } from '../decision-engine/demand-metrics.service';
import { DEFAULT_ENGINE_CONFIG } from '../decision-engine/engine-config.service';
import { PricingEvaluator, PricingEvaluationResult } from '../decision-engine/pricing-evaluator';

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
   */
  async evaluatePricingRecommendation(input: PricingEvaluationInput): Promise<PricingEvaluationResult> {
    const {
      storeId,
      stockItemId,
      sellingPrice,
      costPrice,
      minimumMarginPct,
      maxMarkdownPct,
      maxMarkupPct,
      daysSinceLastSale,
      daysOfCover,
      overstockScore,
      stockoutScore,
      trend,
      confidenceScore,
      engineVersion = 'DECISION_ENGINE_V1',
    } = input;

    const evaluation = this.evaluator.evaluatePricing({
      sellingPrice,
      costPrice,
      minimumMarginPct,
      maxMarkdownPct,
      maxMarkupPct,
      daysSinceLastSale,
      daysOfCover,
      overstockScore,
      stockoutScore,
      trend,
      confidenceScore,
    });

    if (!evaluation.shouldGenerateRecommendation) {
      return evaluation;
    }

    const reasonJson = {
      sellingPrice,
      costPrice,
      minimumPrice: evaluation.minimumPrice,
      expectedMarginPct: evaluation.expectedMarginPct,
      discountPct: evaluation.discountPct,
      action: evaluation.action,
      factors: evaluation.factors,
    };

    await this.prisma.$transaction(async (tx) => {
      await this.lockStockItem(tx, stockItemId);

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
    });

    return evaluation;
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

  async acceptRecommendation(storeId: number, userId: number, recommendationId: number, applyToStockItem = true) {
    return this.prisma.$transaction(async (tx) => {
      const rec = await this.getPendingRecommendationForDecision(tx, storeId, recommendationId);
      await this.assertStockPriceNotStale(tx, rec.stockItemId, rec.currentPrice);

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

      return updated;
    });
  }

  async rejectRecommendation(storeId: number, userId: number, recommendationId: number, _reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.getPendingRecommendationForDecision(tx, storeId, recommendationId);

      return tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'REJECTED',
          decidedById: userId,
          decidedAt: new Date(),
        },
      });
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
      await this.assertStockPriceNotStale(tx, rec.stockItemId, rec.currentPrice);

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

      return updated;
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
    await tx.$queryRaw`SELECT id FROM pricing_recommendations WHERE id = ${recommendationId} FOR UPDATE`;

    const rec = await tx.pricingRecommendation.findUnique({
      where: { id: recommendationId },
      include: { stockItem: true },
    });

    if (!rec || rec.storeId !== storeId) {
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
    stockItemId: number,
    recommendationCurrentPrice: Prisma.Decimal
  ) {
    const stockItem = await this.lockStockItem(tx, stockItemId);
    if (!new Prisma.Decimal(stockItem.sellingPrice).equals(new Prisma.Decimal(recommendationCurrentPrice))) {
      throw new ConflictError('STALE_PRICING_RECOMMENDATION');
    }
  }

  private async lockStockItem(tx: Prisma.TransactionClient, stockItemId: number) {
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${stockItemId} FOR UPDATE`;

    const stockItem = await tx.stockItem.findUnique({
      where: { id: stockItemId },
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
