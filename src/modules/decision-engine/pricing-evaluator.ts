import { DemandTrend } from './demand-metrics.service';

export interface PricingEvaluationInput {
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
}

export interface PricingEvaluationResult {
  action: 'INCREASE' | 'DECREASE' | 'MAINTAIN';
  currentPrice: number;
  recommendedPrice: number;
  discountPct: number;
  minimumPrice: number;
  expectedMarginPct: number;
  confidence: number;
  factors: Array<{ code: string; label: string; impact: string; value?: unknown }>;
  shouldGenerateRecommendation: boolean;
}

export class PricingEvaluator {
  /**
   * Calculates minimum allowed price using gross margin on selling price formula:
   * minimumPrice = costPrice / (1 - minimumMarginPct)
   */
  public static calculateMinimumPrice(costPrice: number, minimumMarginPct: number): number {
    if (minimumMarginPct >= 1.0) {
      return costPrice;
    }
    const raw = costPrice / (1.0 - minimumMarginPct);
    return Math.ceil(raw / 1000) * 1000;
  }

  /**
   * Evaluates pricing recommendation based on margin, velocity, trends, and stock risks.
   */
  evaluatePricing(input: PricingEvaluationInput): PricingEvaluationResult {
    const {
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
    } = input;

    const minimumPrice = PricingEvaluator.calculateMinimumPrice(costPrice, minimumMarginPct);
    const factors: Array<{ code: string; label: string; impact: string; value?: unknown }> = [];

    // CRITICAL: Selling below cost (loss-making) - Must always recommend price correction
    if (costPrice > 0 && sellingPrice < costPrice) {
      factors.push({
        code: 'SELLING_AT_LOSS',
        label: `Sản phẩm đang bán dưới giá vốn (Giá bán: ${sellingPrice.toLocaleString('vi-VN')} đ < Giá vốn: ${costPrice.toLocaleString('vi-VN')} đ). Cần điều chỉnh để bảo toàn vốn.`,
        impact: 'CẦN_TĂNG_GIÁ_NGAY',
        value: { sellingPrice, costPrice, lossPerUnit: costPrice - sellingPrice },
      });

      const targetPrice = Math.max(minimumPrice, Math.ceil((costPrice * 1.15) / 1000) * 1000);
      return {
        action: 'INCREASE',
        currentPrice: sellingPrice,
        recommendedPrice: targetPrice,
        discountPct: 0,
        minimumPrice,
        expectedMarginPct: Number((((targetPrice - costPrice) / targetPrice) * 100).toFixed(1)),
        confidence: Math.max(confidenceScore, 90),
        factors,
        shouldGenerateRecommendation: true,
      };
    }

    // WARNING: Below minimum required gross margin
    if (costPrice > 0 && sellingPrice < minimumPrice) {
      const curMargin = Number((((sellingPrice - costPrice) / Math.max(1, sellingPrice)) * 100).toFixed(1));
      const targetMargin = Number((minimumMarginPct * 100).toFixed(0));
      factors.push({
        code: 'BELOW_MINIMUM_MARGIN',
        label: `Biên lợi nhuận gộp hiện tại (${curMargin}%) thấp hơn mục tiêu tối thiểu (${targetMargin}%). Đề xuất tăng giá lên mức an toàn.`,
        impact: 'TĂNG_GIÁ_ĐẠT_BIÊN',
        value: { sellingPrice, costPrice, minimumPrice, curMargin, targetMargin },
      });

      return {
        action: 'INCREASE',
        currentPrice: sellingPrice,
        recommendedPrice: minimumPrice,
        discountPct: 0,
        minimumPrice,
        expectedMarginPct: Number((((minimumPrice - costPrice) / minimumPrice) * 100).toFixed(1)),
        confidence: Math.max(confidenceScore, 80),
        factors,
        shouldGenerateRecommendation: true,
      };
    }

    // Fallback: Low confidence (< 40) -> MAINTAIN to avoid risky price adjustments on unreliable data
    if (confidenceScore < 40) {
      factors.push({
        code: 'LOW_CONFIDENCE',
        label: 'Dữ liệu lịch sử chưa đủ tin cậy (< 40) để đưa ra đề xuất thay đổi giá an toàn',
        impact: 'GIỮ_NGUYÊN_GIÁ',
      });

      return {
        action: 'MAINTAIN',
        currentPrice: sellingPrice,
        recommendedPrice: sellingPrice,
        discountPct: 0,
        minimumPrice,
        expectedMarginPct: Number((((sellingPrice - costPrice) / Math.max(1, sellingPrice)) * 100).toFixed(1)),
        confidence: confidenceScore,
        factors,
        shouldGenerateRecommendation: false,
      };
    }

    // CASE 1: DECREASE (Markdown candidate due to Dead Stock, Slow Moving, or High Overstock)
    if (
      (daysSinceLastSale !== null && daysSinceLastSale >= 30) ||
      overstockScore >= 50 ||
      (daysOfCover !== null && daysOfCover > 45)
    ) {
      let baseMarkdown = 0.10;

      if (daysSinceLastSale !== null && daysSinceLastSale >= 180) {
        baseMarkdown = 0.25;
        factors.push({
          code: 'DEAD_STOCK_CRITICAL',
          label: `Hàng ứ đọng trên 180 ngày (${daysSinceLastSale} ngày không bán)`,
          impact: 'GIẢM_25%',
          value: daysSinceLastSale,
        });
      } else if (daysSinceLastSale !== null && daysSinceLastSale >= 90) {
        baseMarkdown = 0.15;
        factors.push({
          code: 'DEAD_STOCK_WARNING',
          label: `Hàng chậm luân chuyển (${daysSinceLastSale} ngày không bán)`,
          impact: 'GIẢM_15%',
          value: daysSinceLastSale,
        });
      } else {
        factors.push({
          code: 'OVERSTOCK_RISK',
          label: `Tồn kho dư thừa cao (Điểm rủi ro: ${overstockScore}, Độ phủ: ${daysOfCover ?? 'N/A'} ngày)`,
          impact: 'GIẢM_10%',
          value: { overstockScore, daysOfCover },
        });
      }

      // Trend adjustment
      let trendAdj = 0;
      if (trend === 'STRONG_DOWN') {
        trendAdj = 0.05;
        factors.push({ code: 'TREND_STRONG_DOWN', label: 'Xu hướng nhu cầu giảm mạnh', impact: '+5% giảm giá' });
      } else if (trend === 'DOWN') {
        trendAdj = 0.03;
        factors.push({ code: 'TREND_DOWN', label: 'Xu hướng nhu cầu giảm', impact: '+3% giảm giá' });
      } else if (trend === 'UP' || trend === 'STRONG_UP') {
        trendAdj = -0.05;
        factors.push({ code: 'TREND_UP', label: 'Nhu cầu đang có xu hướng tăng', impact: '-5% giảm giá' });
      }

      const rawDiscount = Math.min(maxMarkdownPct, Math.max(0.05, baseMarkdown + trendAdj));
      const targetPrice = sellingPrice * (1.0 - rawDiscount);

      // Apply Minimum Price Floor Guard
      const clampedPrice = Math.max(minimumPrice, targetPrice);
      const roundedPrice = Math.round(clampedPrice / 1000) * 1000;

      if (roundedPrice < sellingPrice) {
        const actualDiscountPct = Number((((sellingPrice - roundedPrice) / sellingPrice) * 100).toFixed(1));
        const expectedMarginPct = Number((((roundedPrice - costPrice) / roundedPrice) * 100).toFixed(1));

        factors.push({
          code: 'PRICE_FLOOR_GUARD',
          label: `Giá sàn bảo đảm biên lợi nhuận tối thiểu ${(minimumMarginPct * 100).toFixed(0)}%: ${minimumPrice.toLocaleString()} đ`,
          impact: 'BẢO_VỆ_GIÁ_SÀN',
          value: { minimumPrice, expectedMarginPct },
        });

        return {
          action: 'DECREASE',
          currentPrice: sellingPrice,
          recommendedPrice: roundedPrice,
          discountPct: actualDiscountPct,
          minimumPrice,
          expectedMarginPct,
          confidence: confidenceScore,
          factors,
          shouldGenerateRecommendation: true,
        };
      }
    }

    // CASE 2: INCREASE (Markup candidate due to High Stockout Risk + Strong Demand Trend)
    if (stockoutScore >= 60 && (trend === 'UP' || trend === 'STRONG_UP')) {
      const markupPct = trend === 'STRONG_UP' ? Math.min(maxMarkupPct, 0.15) : Math.min(maxMarkupPct, 0.08);
      const targetPrice = Math.round((sellingPrice * (1.0 + markupPct)) / 1000) * 1000;

      if (targetPrice > sellingPrice) {
        factors.push({
          code: 'HIGH_DEMAND_LOW_STOCK',
          label: `Nhu cầu tăng cao trong khi tồn kho khan hiếm (Stockout Risk: ${stockoutScore})`,
          impact: `TĂNG_${(markupPct * 100).toFixed(0)}%`,
        });

        const expectedMarginPct = Number((((targetPrice - costPrice) / targetPrice) * 100).toFixed(1));

        return {
          action: 'INCREASE',
          currentPrice: sellingPrice,
          recommendedPrice: targetPrice,
          discountPct: 0,
          minimumPrice,
          expectedMarginPct,
          confidence: confidenceScore,
          factors,
          shouldGenerateRecommendation: true,
        };
      }
    }

    // CASE 3: MAINTAIN
    factors.push({
      code: 'BALANCED_DEMAND_STOCK',
      label: 'Mức giá và tồn kho hiện tại đang ở trạng thái cân bằng',
      impact: 'GIỮ_NGUYÊN_GIÁ',
    });

    return {
      action: 'MAINTAIN',
      currentPrice: sellingPrice,
      recommendedPrice: sellingPrice,
      discountPct: 0,
      minimumPrice,
      expectedMarginPct: Number((((sellingPrice - costPrice) / Math.max(1, sellingPrice)) * 100).toFixed(1)),
      confidence: confidenceScore,
      factors,
      shouldGenerateRecommendation: false,
    };
  }
}
