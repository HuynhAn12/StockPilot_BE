import { PrismaClient, Prisma, RecommendationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { DemandTrend } from '../decision-engine/demand-metrics.service';
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

    // Check if there is already a PENDING recommendation for this SKU
    const existing = await this.prisma.pricingRecommendation.findFirst({
      where: {
        storeId,
        stockItemId,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      await this.prisma.pricingRecommendation.update({
        where: { id: existing.id },
        data: {
          currentPrice: new Prisma.Decimal(sellingPrice),
          recommendedPrice: new Prisma.Decimal(evaluation.recommendedPrice),
          discountPct: new Prisma.Decimal(evaluation.discountPct),
          action: evaluation.action,
          riskScore: new Prisma.Decimal(Math.max(overstockScore, stockoutScore)),
          confidence: new Prisma.Decimal(confidenceScore),
          reasonJson: reasonJson as Prisma.InputJsonValue,
          engineVersion,
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
        },
      });
    } else {
      await this.prisma.pricingRecommendation.create({
        data: {
          storeId,
          stockItemId,
          currentPrice: new Prisma.Decimal(sellingPrice),
          recommendedPrice: new Prisma.Decimal(evaluation.recommendedPrice),
          discountPct: new Prisma.Decimal(evaluation.discountPct),
          action: evaluation.action,
          riskScore: new Prisma.Decimal(Math.max(overstockScore, stockoutScore)),
          confidence: new Prisma.Decimal(confidenceScore),
          reasonJson: reasonJson as Prisma.InputJsonValue,
          status: 'PENDING',
          engineVersion,
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
    }

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
    const rec = await this.prisma.pricingRecommendation.findUnique({
      where: { id: recommendationId },
      include: { stockItem: true },
    });

    if (!rec || rec.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy đề xuất điều chỉnh giá');
    }

    if (rec.status !== 'PENDING') {
      throw new ValidationError(`Không thể chấp nhận đề xuất ở trạng thái ${rec.status}`);
    }

    return await this.prisma.$transaction(async (tx) => {
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

        // Record immutable price history
        await tx.priceHistory.create({
          data: {
            storeId,
            stockItemId: rec.stockItemId,
            oldPrice,
            newPrice,
            source: 'RECOMMENDATION_ACCEPT',
            recommendationId: rec.id,
            changedById: userId,
            reason: `Chấp nhận đề xuất điều chỉnh giá từ hệ thống (${rec.action})`,
          },
        });
      }

      return updated;
    });
  }

  async rejectRecommendation(storeId: number, userId: number, recommendationId: number, _reason?: string) {
    const rec = await this.prisma.pricingRecommendation.findUnique({
      where: { id: recommendationId },
    });

    if (!rec || rec.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy đề xuất điều chỉnh giá');
    }

    if (rec.status !== 'PENDING') {
      throw new ValidationError(`Không thể từ chối đề xuất ở trạng thái ${rec.status}`);
    }

    const updated = await this.prisma.pricingRecommendation.update({
      where: { id: recommendationId },
      data: {
        status: 'REJECTED',
        decidedById: userId,
        decidedAt: new Date(),
      },
    });

    return updated;
  }

  async modifyRecommendation(
    storeId: number,
    userId: number,
    recommendationId: number,
    customPrice: number,
    applyToStockItem = true
  ) {
    const rec = await this.prisma.pricingRecommendation.findUnique({
      where: { id: recommendationId },
      include: { stockItem: true },
    });

    if (!rec || rec.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy đề xuất điều chỉnh giá');
    }

    if (rec.status !== 'PENDING') {
      throw new ValidationError(`Không thể sửa đổi đề xuất ở trạng thái ${rec.status}`);
    }

    // Validate customPrice vs cost price
    const costPrice = Number(rec.stockItem.costPrice);
    if (customPrice < costPrice) {
      throw new ValidationError(`Giá đề xuất mới (${customPrice.toLocaleString()} đ) không được thấp hơn giá vốn (${costPrice.toLocaleString()} đ)`);
    }

    return await this.prisma.$transaction(async (tx) => {
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

        // Record immutable price history
        await tx.priceHistory.create({
          data: {
            storeId,
            stockItemId: rec.stockItemId,
            oldPrice,
            newPrice,
            source: 'RECOMMENDATION_MODIFY',
            recommendationId: rec.id,
            changedById: userId,
            reason: `Chủ cửa hàng điều chỉnh giá theo đề xuất tuỳ chỉnh (${customPrice.toLocaleString()} đ)`,
          },
        });
      }

      return updated;
    });
  }

  async getPriceHistories(storeId: number, stockItemId?: number, limit = 50) {
    return await this.prisma.priceHistory.findMany({
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
}
