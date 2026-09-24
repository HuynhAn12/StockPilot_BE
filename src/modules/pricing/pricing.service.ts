import { PrismaClient, Prisma, RecommendationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { DemandTrend } from '../decision-engine/demand.service';

export interface PricingEvaluationInput {
  storeId: number;
  stockItemId: number;
  sellingPrice: number;
  costPrice: number;
  minimumMarginPct: number;
  daysSinceLastSale: number | null;
  daysOfInventory: number | null;
  overstockScore: number;
  trend: DemandTrend;
}

export class PricingService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /**
   * Evaluates if a pricing recommendation should be generated for a SKU.
   */
  async evaluatePricingRecommendation(input: PricingEvaluationInput) {
    const {
      storeId,
      stockItemId,
      sellingPrice,
      costPrice,
      minimumMarginPct,
      daysSinceLastSale,
      daysOfInventory,
      overstockScore,
      trend,
    } = input;

    // 1. Price floor guard: priceFloor = costPrice * (1 + minimumMarginPct)
    const priceFloor = Math.ceil(costPrice * (1 + minimumMarginPct));

    // If current selling price is already at or below floor, no markdown recommended
    if (sellingPrice <= priceFloor) {
      return null;
    }

    // 2. Base discount determination
    let baseDiscount = 0;
    const factors: Array<{ code: string; label: string; impact: string; value?: unknown }> = [];

    if (daysSinceLastSale !== null && daysSinceLastSale >= 180) {
      baseDiscount = 0.25;
      factors.push({
        code: 'DEAD_STOCK_CRITICAL',
        label: `Tồn kho bất động trên 180 ngày (${daysSinceLastSale} ngày không phát sinh bán)`,
        impact: 'GIẢM_25%',
        value: daysSinceLastSale,
      });
    } else if (daysSinceLastSale !== null && daysSinceLastSale >= 90) {
      baseDiscount = 0.15;
      factors.push({
        code: 'DEAD_STOCK_WARNING',
        label: `Tồn kho chậm luân chuyển (${daysSinceLastSale} ngày không phát sinh bán)`,
        impact: 'GIẢM_15%',
        value: daysSinceLastSale,
      });
    } else if (overstockScore >= 50 || (daysOfInventory !== null && daysOfInventory > 60)) {
      baseDiscount = 0.1;
      factors.push({
        code: 'OVERSTOCK_RISK',
        label: `Tồn kho dư thừa cao (Điểm rủi ro: ${overstockScore}, DOI: ${daysOfInventory ?? 'N/A'} ngày)`,
        impact: 'GIẢM_10%',
        value: { overstockScore, daysOfInventory },
      });
    }

    // If no risk trigger, return null
    if (baseDiscount === 0) {
      return null;
    }

    // 3. Trend adjustment
    let trendAdjustment = 0;
    if (trend === 'STRONG_DOWN') {
      trendAdjustment = 0.05;
      factors.push({ code: 'DEMAND_TREND_STRONG_DOWN', label: 'Xu hướng nhu cầu giảm mạnh', impact: '+5% giảm giá' });
    } else if (trend === 'DOWN') {
      trendAdjustment = 0.03;
      factors.push({ code: 'DEMAND_TREND_DOWN', label: 'Xu hướng nhu cầu giảm', impact: '+3% giảm giá' });
    } else if (trend === 'UP') {
      trendAdjustment = -0.03;
      factors.push({ code: 'DEMAND_TREND_UP', label: 'Nhu cầu đang có xu hướng tăng', impact: '-3% giảm giá' });
    } else if (trend === 'STRONG_UP') {
      trendAdjustment = -0.05;
      factors.push({ code: 'DEMAND_TREND_STRONG_UP', label: 'Nhu cầu tăng mạnh', impact: '-5% giảm giá' });
    }

    const totalDiscountPct = Math.min(0.4, Math.max(0.05, baseDiscount + trendAdjustment));
    const candidatePrice = sellingPrice * (1 - totalDiscountPct);

    // Apply Price Floor Clamp
    let finalRecommendedPrice = Math.max(priceFloor, candidatePrice);

    // Round to nearest 1,000 VND
    finalRecommendedPrice = Math.round(finalRecommendedPrice / 1000) * 1000;

    // Safety check: recommended price must be strictly less than current price
    if (finalRecommendedPrice >= sellingPrice) {
      return null;
    }

    const actualDiscountPct = Number((((sellingPrice - finalRecommendedPrice) / sellingPrice) * 100).toFixed(1));
    const expectedMarginPct = Number((((finalRecommendedPrice - costPrice) / finalRecommendedPrice) * 100).toFixed(1));

    factors.push({
      code: 'PRICE_FLOOR_GUARD',
      label: `Biên lợi nhuận tối thiểu bảo đảm: ${(minimumMarginPct * 100).toFixed(0)}% (Giá sàn: ${priceFloor.toLocaleString()} đ)`,
      impact: 'GIÁ_SÀN_BẢO_VỆ',
      value: { priceFloor, expectedMarginPct },
    });

    const reasonJson = {
      sellingPrice,
      costPrice,
      priceFloor,
      minimumMarginPct,
      expectedMarginPct,
      actualDiscountPct,
      factors,
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
      const updated = await this.prisma.pricingRecommendation.update({
        where: { id: existing.id },
        data: {
          currentPrice: new Prisma.Decimal(sellingPrice),
          recommendedPrice: new Prisma.Decimal(finalRecommendedPrice),
          discountPct: new Prisma.Decimal(actualDiscountPct),
          score: new Prisma.Decimal(overstockScore),
          reasonJson: reasonJson as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
        },
      });
      return updated;
    }

    const created = await this.prisma.pricingRecommendation.create({
      data: {
        storeId,
        stockItemId,
        currentPrice: new Prisma.Decimal(sellingPrice),
        recommendedPrice: new Prisma.Decimal(finalRecommendedPrice),
        discountPct: new Prisma.Decimal(actualDiscountPct),
        score: new Prisma.Decimal(overstockScore),
        reasonJson: reasonJson as Prisma.InputJsonValue,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });

    return created;
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
      const updated = await tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'ACCEPTED',
          acceptedPrice: rec.recommendedPrice,
          decidedById: userId,
          decidedAt: new Date(),
        },
      });

      if (applyToStockItem) {
        await tx.stockItem.update({
          where: { id: rec.stockItemId },
          data: { sellingPrice: rec.recommendedPrice },
        });
      }

      return updated;
    });
  }

  async rejectRecommendation(storeId: number, userId: number, recommendationId: number) {
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
      const updated = await tx.pricingRecommendation.update({
        where: { id: recommendationId },
        data: {
          status: 'MODIFIED',
          acceptedPrice: new Prisma.Decimal(customPrice),
          decidedById: userId,
          decidedAt: new Date(),
        },
      });

      if (applyToStockItem) {
        await tx.stockItem.update({
          where: { id: rec.stockItemId },
          data: { sellingPrice: new Prisma.Decimal(customPrice) },
        });
      }

      return updated;
    });
  }
}
