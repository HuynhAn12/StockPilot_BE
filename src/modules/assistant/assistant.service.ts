import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { DecisionEngineService, SkuDecisionAnalysisResult } from '../decision-engine/decision-engine.service';

export class AssistantService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly decisionEngineService: DecisionEngineService = new DecisionEngineService(prisma)
  ) {}

  /**
   * Generates a deterministic, factual explanation for a SKU's decision engine state.
   */
  async explainSku(storeId: number, stockItemId: number, question?: string) {
    const analysis = await this.decisionEngineService.analyzeSku(storeId, stockItemId);

    // Fetch active alerts for this SKU
    const alerts = await this.prisma.smartAlert.findMany({
      where: {
        storeId,
        stockItemId,
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      },
      select: {
        type: true,
        severity: true,
        title: true,
        message: true,
        score: true,
      },
    });

    // Fetch active pricing recommendation
    const recommendation = await this.prisma.pricingRecommendation.findFirst({
      where: {
        storeId,
        stockItemId,
        status: 'PENDING',
      },
      select: {
        currentPrice: true,
        recommendedPrice: true,
        discountPct: true,
        reasonJson: true,
      },
    });

    const context = {
      product: {
        id: analysis.stockItemId,
        sku: analysis.sku,
        name: analysis.productName,
        category: analysis.categoryName,
        costPrice: analysis.pricing.costPrice,
        sellingPrice: analysis.pricing.sellingPrice,
      },
      inventory: analysis.inventory,
      demand: analysis.demand,
      policy: analysis.policy,
      metrics: analysis.metrics,
      risks: analysis.risks,
      activeAlerts: alerts,
      pricingRecommendation: recommendation,
    };

    // Construct deterministic natural explanation based on exact numbers
    const explanationParagraphs: string[] = [];

    // 1. Inventory & Demand summary
    explanationParagraphs.push(
      `Sản phẩm "${analysis.productName}" (SKU: ${analysis.sku}) hiện có ${analysis.inventory.available} đơn vị khả dụng trong kho (tổng tồn ${analysis.inventory.onHand}, đang giữ chỗ ${analysis.inventory.reserved}). Nhu cầu tiêu thụ trung bình 30 ngày qua là ${analysis.demand.avg30} đơn vị/ngày.`
    );

    // 2. Stockout Risk Explanation
    if (analysis.risks.stockoutScore >= 50 || analysis.inventory.available <= 0) {
      if (analysis.inventory.available <= 0) {
        explanationParagraphs.push(
          `CẢNH BÁO HẾT HÀNG (Điểm rủi ro: 100/100): Sản phẩm hiện không còn hàng tồn trong kho. Với lead time nhập hàng ${analysis.policy.leadTimeDays} ngày và điểm đặt hàng lại ROP là ${analysis.metrics.reorderPoint} đơn vị, cần tạo đơn nhập hàng ngay lập tức để tránh mất doanh số.`
        );
      } else {
        explanationParagraphs.push(
          `NGUY CƠ THIẾU HÀNG CAO (Điểm rủi ro: ${analysis.risks.stockoutScore}/100): Tồn kho khả dụng (${analysis.inventory.available}) đang thấp hơn điểm đặt hàng lại (${analysis.metrics.reorderPoint} đơn vị, bao gồm ${analysis.metrics.safetyStock} đơn vị tồn an toàn). Thời gian tồn kho ước tính (DOI) chỉ còn ${analysis.metrics.daysOfInventory ?? 'N/A'} ngày trong khi thời gian giao hàng từ nhà cung cấp là ${analysis.policy.leadTimeDays} ngày.`
        );
      }
    } else {
      explanationParagraphs.push(
        `Tình trạng cung ứng an toàn: Mức tồn ${analysis.inventory.available} đơn vị cao hơn điểm đặt hàng lại ${analysis.metrics.reorderPoint} đơn vị (DOI: ${analysis.metrics.daysOfInventory ?? 'N/A'} ngày).`
      );
    }

    // 3. Overstock / Dead Stock Explanation
    if (analysis.risks.isDeadStock) {
      explanationParagraphs.push(
        `CẢNH BÁO TỒN KHO Ứ ĐỌNG: Sản phẩm chưa có giao dịch bán hàng nào trong ${analysis.risks.daysSinceLastSale ?? 90} ngày qua, làm đọng khoảng ${(analysis.risks.deadStockCostValue).toLocaleString()} VNĐ vốn giá gốc.`
      );
    } else if (analysis.risks.overstockScore >= 50) {
      explanationParagraphs.push(
        `CẢNH BÁO THỪA HÀNG (Điểm rủi ro: ${analysis.risks.overstockScore}/100): Tồn kho hiện tại vượt mức tối đa hoặc mục tiêu lưu kho ${analysis.policy.targetCoverageDays} ngày.`
      );
    }

    // 4. Pricing recommendation note
    if (recommendation) {
      explanationParagraphs.push(
        `ĐỀ XUẤT ĐIỀU CHỈNH GIÁ: Hệ thống đề xuất giảm ${recommendation.discountPct}% từ ${Number(recommendation.currentPrice).toLocaleString()} VNĐ xuống ${Number(recommendation.recommendedPrice).toLocaleString()} VNĐ nhằm kích cầu giải phóng tồn kho, đồng thời vẫn bảo đảm biên lợi nhuận tối thiểu ${(analysis.policy.minimumMarginPct * 100).toFixed(0)}%.`
      );
    }

    return {
      stockItemId,
      sku: analysis.sku,
      productName: analysis.productName,
      question: question || 'Phân tích tổng quan tình trạng sản phẩm và tồn kho',
      explanation: explanationParagraphs.join('\n\n'),
      factualContext: context,
    };
  }

  /**
   * Generates store-wide intelligence summary.
   */
  async explainStoreOverview(storeId: number) {
    const overview = await this.decisionEngineService.getOverview(storeId, {
      riskFilter: 'ALL',
      page: 1,
      limit: 100,
    });

    const openAlertsCount = await this.prisma.smartAlert.count({
      where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });

    const pendingRecsCount = await this.prisma.pricingRecommendation.count({
      where: { storeId, status: 'PENDING' },
    });

    const summaryText = [
      `TỔNG QUAN KHO HÀNG HÔM NAY:`,
      `- Tổng số mặt hàng (SKU) đang quản lý: ${overview.summary.totalSkus}`,
      `- SKU có nguy cơ thiếu hàng / hết hàng: ${overview.summary.stockoutRiskCount}`,
      `- SKU thừa hàng / tồn kho quá mức: ${overview.summary.overstockRiskCount}`,
      `- SKU ứ đọng (Dead Stock): ${overview.summary.deadStockCount} (Tổng vốn đọng: ${overview.summary.totalDeadStockCostValue.toLocaleString()} VNĐ)`,
      `- Cảnh báo thông minh chưa xử lý: ${openAlertsCount}`,
      `- Đề xuất điều chỉnh giá chờ duyệt: ${pendingRecsCount}`,
    ].join('\n');

    return {
      storeId,
      summary: summaryText,
      metrics: overview.summary,
      openAlertsCount,
      pendingRecommendationsCount: pendingRecsCount,
      generatedAt: new Date().toISOString(),
    };
  }
}
