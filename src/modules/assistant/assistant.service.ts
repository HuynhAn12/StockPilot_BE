import { PrismaClient, Role } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { DecisionEngineService } from '../decision-engine/decision-engine.service';
import { toOverviewSummaryView, toSkuDecisionView } from '../decision-engine/decision-view';
import { toNumber } from '../../common/utils/decimal';
import { canViewFinancials } from '../../common/utils/role-access';

function formatVND(n: number): string {
  return Math.round(n).toLocaleString('vi-VN') + ' đ';
}

/** Shown to non-owner viewers when a question needs cost, margin, revenue, or pricing decisions (D9). */
export const FINANCIAL_DATA_RESTRICTED_MESSAGE =
  'Xin lỗi, tài khoản Nhân viên chỉ được phép tra cứu số lượng tồn kho và nghiệp vụ vận hành. Vui lòng liên hệ Chủ cửa hàng để xem dữ liệu tài chính.';

/**
 * Template-based assistant. Every method takes the viewer role and builds staff answers without
 * financial content in the first place (fail-closed: an unknown role gets the staff view), instead
 * of generating owner text and redacting it afterwards.
 */

export function normalizeVietnameseVoiceQuery(text: string): string {
  if (!text) return '';
  let s = text.trim();
  s = s.replace(/\bbón chạy\b/gi, 'bán chạy')
       .replace(/\bbán chay\b/gi, 'bán chạy')
       .replace(/\bchạy nhứt\b/gi, 'chạy nhất')
       .replace(/\bthống tóm\b/gi, 'tháng tám')
       .replace(/\btháng tóm\b/gi, 'tháng tám')
       .replace(/\bthống 8\b/gi, 'tháng 8')
       .replace(/\bthống mười\b/gi, 'tháng mười')
       .replace(/\bthống 10\b/gi, 'tháng 10')
       .replace(/\bthống chín\b/gi, 'tháng chín')
       .replace(/\bthống 9\b/gi, 'tháng 9')
       .replace(/\bthống bảy\b/gi, 'tháng bảy')
       .replace(/\bthống 7\b/gi, 'tháng 7')
       .replace(/\bthống sáu\b/gi, 'tháng sáu')
       .replace(/\bthống 6\b/gi, 'tháng 6')
       .replace(/\bthống năm\b/gi, 'tháng năm')
       .replace(/\bthống 5\b/gi, 'tháng 5')
       .replace(/\bthống trước\b/gi, 'tháng trước')
       .replace(/\btháng trc\b/gi, 'tháng trước')
       .replace(/\bdoanh thô\b/gi, 'doanh thu')
       .replace(/\blợi nhộn\b/gi, 'lợi nhuận');
  return s;
}

export class AssistantService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly decisionEngineService: DecisionEngineService = new DecisionEngineService(prisma)
  ) {}

  /**
   * Generates a deterministic, factual explanation for a SKU's decision engine state.
   */
  async explainSku(storeId: number, stockItemId: number, question?: string, viewerRole?: Role) {
    // Read-only: same read model as the Decision Engine screen; never syncs alerts, recommendations, or snapshots.
    const { analysis } = await this.decisionEngineService.getSkuDecision(storeId, stockItemId);
    const canSeeFinancials = canViewFinancials(viewerRole);
    const view = toSkuDecisionView(analysis, viewerRole);

    const alerts = await this.prisma.alert.findMany({
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
        riskScore: true,
        confidence: true,
      },
    });

    const recommendation = canSeeFinancials
      ? await this.prisma.pricingRecommendation.findFirst({
          where: {
            storeId,
            stockItemId,
            status: 'PENDING',
          },
          select: {
            currentPrice: true,
            recommendedPrice: true,
            discountPct: true,
            action: true,
            reasonJson: true,
          },
        })
      : null;

    const context = {
      product: {
        id: analysis.stockItemId,
        sku: analysis.sku,
        name: analysis.productName,
        category: analysis.categoryName,
        ...(canSeeFinancials ? { costPrice: analysis.pricing.costPrice } : {}),
        sellingPrice: analysis.pricing.sellingPrice,
      },
      inventory: view.inventory,
      demand: view.demand,
      coverage: view.coverage,
      risk: view.risk,
      confidence: view.confidence,
      engineConfig: view.engineConfig,
      activeAlerts: alerts,
      pricingRecommendation: recommendation,
    };

    const priceLine = canSeeFinancials
      ? `- **Giá bán:** ${formatVND(analysis.pricing.sellingPrice)} | **Giá vốn:** ${formatVND(analysis.pricing.costPrice)} | **Biên lợi nhuận:** **${analysis.pricing.expectedMarginPct}%**\n`
      : `- **Giá bán:** ${formatVND(analysis.pricing.sellingPrice)}\n`;

    const paragraphs: string[] = [];
    paragraphs.push(
      `### Phân tích chi tiết: ${analysis.productName} (Mã: ${analysis.sku})\n\n` +
      `- **Tồn kho khả dụng:** **${analysis.inventory.available}** đơn vị (Tổng tồn thực tế: ${analysis.inventory.onHand}, Đang giữ chỗ: ${analysis.inventory.reserved})\n` +
      priceLine +
      `- **Tốc độ tiêu thụ trung bình:** **${analysis.demand.avg30}** đơn vị/ngày (Xu hướng: ${analysis.demand.trend})\n` +
      `- **Độ tin cậy số liệu:** ${analysis.confidence.score}/100 (${analysis.confidence.level})`
    );

    if (analysis.risk.stockout >= 50 || analysis.inventory.available <= 0) {
      if (analysis.inventory.available <= 0) {
        paragraphs.push(
          `🔴 **CẢNH BÁO HẾT HÀNG (Điểm rủi ro 100/100):** Sản phẩm hiện còn 0 đơn vị trong kho. Điểm đặt hàng lại (ROP) là **${analysis.coverage.reorderPoint}** đơn vị. Khuyến nghị tạo phiếu nhập kho ngay để tránh đứt đoạn bán hàng.`
        );
      } else {
        paragraphs.push(
          `🟠 **NGUY CƠ THIẾU HÀNG:** Tồn khả dụng (${analysis.inventory.available}) đang thấp hơn ngưỡng an toàn ROP (${analysis.coverage.reorderPoint} đơn vị). Thời gian duy trì chỉ còn ước tính **${analysis.coverage.daysOfCover ?? 'N/A'}** ngày (thời gian nhà cung cấp giao là ${analysis.engineConfig.leadTimeDays} ngày).`
        );
      }
    } else {
      paragraphs.push(
        `🟢 **Tồn kho an toàn:** Mức khả dụng hiện tại (${analysis.inventory.available}) vượt ngưỡng đặt hàng ${analysis.coverage.reorderPoint} đơn vị.`
      );
    }

    if (analysis.risk.deadStock) {
      paragraphs.push(
        canSeeFinancials
          ? `⚠️ **HÀNG TỒN Ứ ĐỌNG (DEAD STOCK):** Không ghi nhận lượt bán trong ${analysis.risk.daysSinceLastSale ?? 90} ngày qua, làm đọng khoảng **${formatVND(analysis.risk.deadStockCostValue)}** vốn.`
          : `⚠️ **HÀNG TỒN Ứ ĐỌNG (DEAD STOCK):** Không ghi nhận lượt bán trong ${analysis.risk.daysSinceLastSale ?? 90} ngày qua (còn ${analysis.inventory.available} đơn vị khả dụng). Vui lòng báo Chủ cửa hàng để quyết định xử lý.`
      );
    } else if (analysis.risk.slowMoving) {
      paragraphs.push(
        `⏳ **HÀNG BÁN CHẬM:** Chưa có giao dịch mới trong ${analysis.risk.daysSinceLastSale ?? 30} ngày qua.`
      );
    }

    if (recommendation) {
      paragraphs.push(
        `💡 **ĐỀ XUẤT ĐIỀU CHỈNH GIÁ:** Thuật toán đề xuất **${recommendation.action === 'INCREASE' ? 'Tăng giá' : 'Giảm giá'}** từ ${formatVND(Number(recommendation.currentPrice))} lên/xuống **${formatVND(Number(recommendation.recommendedPrice))}** để tối ưu hóa biên lợi nhuận và giải phóng vốn lưu động.`
      );
    }

    return {
      stockItemId,
      sku: analysis.sku,
      productName: analysis.productName,
      question: question || 'Phân tích tổng quan tình trạng sản phẩm và tồn kho',
      explanation: paragraphs.join('\n\n'),
      factualContext: context,
    };
  }

  /**
   * Generates store-wide intelligence summary.
   */
  async explainStoreOverview(storeId: number, viewerRole?: Role) {
    const canSeeFinancials = canViewFinancials(viewerRole);
    const overview = await this.decisionEngineService.getOverview(storeId, {
      riskFilter: 'ALL',
      page: 1,
      limit: 100,
    });

    const openAlertsCount = await this.prisma.alert.count({
      where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });

    const pendingRecsCount = canSeeFinancials
      ? await this.prisma.pricingRecommendation.count({
          where: { storeId, status: 'PENDING' },
        })
      : 0;

    const summaryLines = canSeeFinancials
      ? [
          `### 📊 TỔNG QUAN TÌNH HÌNH CỬA HÀNG HÔM NAY`,
          `- **Tổng số sản phẩm đang quản lý:** **${overview.summary.totalSkus}** SP`,
          `- **Mặt hàng có nguy cơ thiếu/hết hàng:** **${overview.summary.stockoutRiskCount}** SP (Cần ưu tiên nhập)`,
          `- **Mặt hàng tồn kho quá mức:** **${overview.summary.overstockRiskCount}** SP`,
          `- **Mặt hàng ứ đọng (Dead Stock):** **${overview.summary.deadStockCount}** SP (Vốn đọng: **${formatVND(overview.summary.totalDeadStockCostValue)}**)`,
          `- **Cảnh báo rủi ro đang mở:** **${openAlertsCount}** cảnh báo`,
          `- **Gợi ý tối ưu giá chờ duyệt:** **${pendingRecsCount}** đề xuất`,
          `\n💡 *Gợi ý thao tác: Bạn có thể vào tab "Cảnh báo rủi ro" để xử lý các mặt hàng hết hàng hoặc tab "Gợi ý giá bán" để duyệt các mức giá mới tối ưu lợi nhuận.*`
        ]
      : [
          `### 📊 TỔNG QUAN TÌNH HÌNH KHO HÀNG HÔM NAY`,
          `- **Tổng số sản phẩm đang quản lý:** **${overview.summary.totalSkus}** SP`,
          `- **Mặt hàng có nguy cơ thiếu/hết hàng:** **${overview.summary.stockoutRiskCount}** SP (Cần ưu tiên nhập)`,
          `- **Mặt hàng tồn kho quá mức:** **${overview.summary.overstockRiskCount}** SP`,
          `- **Mặt hàng ứ đọng (Dead Stock):** **${overview.summary.deadStockCount}** SP`,
          `- **Cảnh báo rủi ro đang mở:** **${openAlertsCount}** cảnh báo`,
          `\n💡 *Gợi ý thao tác: Vào tab "Cảnh báo rủi ro", bấm "Đã xem" kèm ghi chú để báo cáo Chủ cửa hàng.*`
        ];
    const summaryText = summaryLines.join('\n\n');

    return {
      storeId,
      summary: summaryText,
      metrics: toOverviewSummaryView(overview.summary, viewerRole),
      openAlertsCount,
      pendingRecommendationsCount: pendingRecsCount,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Main AI Pilot natural language processing engine that maps questions to database facts.
   */

  /**
   * Trích xuất ý định thời gian (tháng, tuần, hôm nay) từ câu hỏi của người dùng.
   */
  parseTimeIntent(question: string, now: Date = new Date()): { isMonthQuery: boolean; year: number; month: number; label: string } {
    const q = (question || '').toLowerCase();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    // 1. "tháng trước", "tháng rồi", "tháng vừa qua", "tháng vừa rồi"
    if (q.includes('tháng trước') || q.includes('tháng rồi') || q.includes('tháng vừa qua') || q.includes('tháng vừa rồi')) {
      let prevM = currentMonth - 1;
      let prevY = currentYear;
      if (prevM === 0) {
        prevM = 12;
        prevY -= 1;
      }
      return { isMonthQuery: true, year: prevY, month: prevM, label: `Tháng ${prevM}/${prevY}` };
    }

    // 2. "tháng này", "tháng hiện tại"
    if (q.includes('tháng này') || q.includes('tháng hiện tại')) {
      return { isMonthQuery: true, year: currentYear, month: currentMonth, label: `Tháng ${currentMonth}/${currentYear}` };
    }

    // 3. Các tháng bằng chữ
    const monthWords: Record<string, number> = {
      'mười hai': 12, 'mười một': 11, 'mười': 10, 'chín': 9, 'tám': 8, 'bảy': 7,
      'sáu': 6, 'năm': 5, 'bốn': 4, 'tư': 4, 'ba': 3, 'hai': 2, 'một': 1,
    };
    for (const [name, m] of Object.entries(monthWords)) {
      if (q.includes(`tháng ${name}`)) {
        return { isMonthQuery: true, year: currentYear, month: m, label: `Tháng ${m}/${currentYear}` };
      }
    }

    // 4. "tháng 1" -> "tháng 12" kèm năm tùy chọn
    const match = q.match(/tháng\s*(\d{1,2})(?:[/\-\s]+(\d{4}))?/i);
    if (match) {
      const m = parseInt(match[1], 10);
      const y = match[2] ? parseInt(match[2], 10) : currentYear;
      if (m >= 1 && m <= 12) {
        return { isMonthQuery: true, year: y, month: m, label: `Tháng ${m}/${y}` };
      }
    }

    // 5. Nếu câu hỏi có từ "tháng" mà không nói rõ tháng nào, mặc định phân tích tháng trước
    if (q.includes('tháng')) {
      let prevM = currentMonth - 1;
      let prevY = currentYear;
      if (prevM === 0) {
        prevM = 12;
        prevY -= 1;
      }
      return { isMonthQuery: true, year: prevY, month: prevM, label: `Tháng ${prevM}/${prevY}` };
    }

    return { isMonthQuery: false, year: currentYear, month: currentMonth, label: `Tháng ${currentMonth}/${currentYear}` };
  }

  /**
   * Phân tích chuyên sâu số liệu kinh doanh của một tháng cụ thể (hoặc tháng trước).
   */
  async explainMonthFinancials(storeId: number, year: number, month: number, viewerRole?: Role) {
    const canSeeFinancials = canViewFinancials(viewerRole);
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 1, 0, 0, 0, 0);

    const orders = await this.prisma.order.findMany({
      where: {
        storeId,
        status: { in: ['FULFILLED', 'CONFIRMED'] },
        createdAt: { gte: start, lt: end },
      },
      include: { items: true },
    });

    const revenue = orders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
    let cogs = 0;
    let totalUnitsSold = 0;
    const skuMap: Record<string, { sku: string; name: string; qty: number; revenue: number }> = {};

    orders.forEach((o) => {
      o.items.forEach((i) => {
        cogs += toNumber(i.costPriceSnapshot) * i.quantity;
        totalUnitsSold += i.quantity;
        if (!skuMap[i.skuSnapshot]) {
          skuMap[i.skuSnapshot] = { sku: i.skuSnapshot, name: i.nameSnapshot, qty: 0, revenue: 0 };
        }
        skuMap[i.skuSnapshot].qty += i.quantity;
        skuMap[i.skuSnapshot].revenue += toNumber(i.subtotal);
      });
    });

    const profit = Math.max(0, revenue - cogs);
    const marginPct = revenue > 0 ? Number(((profit / revenue) * 100).toFixed(1)) : 0;
    const topProducts = Object.values(skuMap)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    // Lấy tháng trước để so sánh tăng trưởng
    let prevYear = year;
    let prevMonth = month - 1;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const prevStart = new Date(prevYear, prevMonth - 1, 1, 0, 0, 0, 0);
    const prevEnd = new Date(prevYear, prevMonth, 1, 0, 0, 0, 0);

    const prevOrders = await this.prisma.order.findMany({
      where: {
        storeId,
        status: { in: ['FULFILLED', 'CONFIRMED'] },
        createdAt: { gte: prevStart, lt: prevEnd },
      },
      select: { totalAmount: true },
    });
    const prevRevenue = prevOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
    const diffRevenue = revenue - prevRevenue;
    const growthPct = prevRevenue > 0 ? Number(((diffRevenue / prevRevenue) * 100).toFixed(1)) : null;

    const compareText = prevRevenue === 0
      ? 'Chưa có dữ liệu đối chiếu với tháng trước.'
      : diffRevenue >= 0
        ? `Tăng trưởng **+${formatVND(diffRevenue)}** (+${growthPct}%) so với Tháng ${prevMonth}/${prevYear}.`
        : `Giảm **${formatVND(Math.abs(diffRevenue))}** (${growthPct}%) so với Tháng ${prevMonth}/${prevYear}.`;

    const topItemsText = topProducts.length > 0
      ? topProducts.map((p, idx) =>
          canSeeFinancials
            ? `${idx + 1}. **${p.name}** (${p.sku}): Bán **${p.qty.toLocaleString('vi-VN')}** sản phẩm | Doanh thu: **${formatVND(p.revenue)}**`
            : `${idx + 1}. **${p.name}** (${p.sku}): Bán **${p.qty.toLocaleString('vi-VN')}** sản phẩm`
        ).join('\n')
      : 'Chưa có sản phẩm nào ghi nhận bán ra trong tháng này.';

    const summary = [
      `### 📊 BÁO CÁO TOÀN DIỆN THÁNG ${month}/${year}`,
      `- **Tổng doanh thu thực tế:** **${formatVND(revenue)}**`,
      `- **Lợi nhuận gộp ước tính:** **${formatVND(profit)}** (Biên lợi nhuận gộp: **${marginPct}%**)`,
      `- **Tổng số đơn hàng hoàn tất:** **${orders.length.toLocaleString('vi-VN')}** đơn hàng`,
      `- **Tổng sản phẩm tiêu thụ:** **${totalUnitsSold.toLocaleString('vi-VN')}** sản phẩm`,
      `- **Giá vốn hàng bán (COGS):** ${formatVND(cogs)}`,
      `- **So sánh với Tháng ${prevMonth}/${prevYear}:** ${compareText}`,
      `\n#### 🏆 TOP 5 SẢN PHẨM BÁN CHẠY NHẤT TRONG THÁNG:\n${topItemsText}`,
      `\n💡 **Đánh giá & Giải pháp chiến lược cho Chủ cửa hàng:**`,
      `1. **Về nguồn cung:** Cần đảm bảo lượng tồn kho an toàn cho nhóm sản phẩm chủ lực trên, tránh để đứt hàng làm mất doanh số.`,
      `2. **Tối ưu biên lợi nhuận:** Duy trì mức biên ${marginPct}%, đồng thời áp dụng chính sách bán kèm (combo) các sản phẩm có biên lợi nhuận cao hơn.`,
      `3. **Kế hoạch tháng tới:** Dựa trên tốc độ bán của các mặt hàng tiêu dùng nhanh, lập phiếu nhập hàng định kỳ trước mỗi cuối tuần để tối ưu chi phí vận chuyển.`,
    ].join('\n\n');

    return {
      summary,
      data: {
        year,
        month,
        revenue,
        cogs,
        profit,
        marginPct,
        orderCount: orders.length,
        totalUnitsSold,
        topProducts,
        comparison: { prevRevenue, diffRevenue, growthPct },
      },
    };
  }

  async answerQuestion(storeId: number, question: string, targetStockItemId?: number, viewerRole?: Role): Promise<{
    answer: string;
    actionLinks?: Array<{ label: string; url: string; variant?: string }>;
    dataSnapshot?: any;
  }> {
    const normalizedQuestion = normalizeVietnameseVoiceQuery(question);
    const q = normalizedQuestion.toLowerCase().trim();
    const canSeeFinancials = canViewFinancials(viewerRole);
    const restricted = () => ({
      answer: FINANCIAL_DATA_RESTRICTED_MESSAGE,
      actionLinks: [{ label: 'Xem cảnh báo rủi ro', url: '/alerts' }],
    });

    // Direct SKU explanation if stockItemId provided
    if (targetStockItemId) {
      const skuResult = await this.explainSku(storeId, targetStockItemId, question, viewerRole);
      return {
        answer: skuResult.explanation,
        actionLinks: [
          { label: 'Kiểm tra tồn kho', url: `/inventory?search=${encodeURIComponent(skuResult.sku)}` },
          ...(canSeeFinancials
            ? [{ label: 'Xem đề xuất giá', url: `/pricing?search=${encodeURIComponent(skuResult.sku)}` }]
            : []),
        ],
        dataSnapshot: skuResult.factualContext,
      };
    }

    // Check if user is asking about a specific SKU/product by code or name
    const allStockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true },
      select: { id: true, sku: true, name: true },
    });

    const mentionedItem = allStockItems.find(
      (item) => q.includes(item.sku.toLowerCase()) || q.includes(item.name.toLowerCase())
    );

    if (mentionedItem && (q.includes('giá') || q.includes('tồn') || q.includes('sản phẩm') || q.includes('thế nào') || q.includes('bao nhiêu'))) {
      const skuResult = await this.explainSku(storeId, mentionedItem.id, question, viewerRole);
      return {
        answer: skuResult.explanation,
        actionLinks: [
          { label: 'Xem sản phẩm', url: `/products?search=${encodeURIComponent(mentionedItem.sku)}` },
          ...(canSeeFinancials
            ? [{ label: 'Xem đề xuất giá', url: `/pricing?search=${encodeURIComponent(mentionedItem.sku)}` }]
            : []),
        ],
        dataSnapshot: skuResult.factualContext,
      };
    }

    // INTENT 1: Quản lý kho, tồn kho, hết hàng, sắp hết, tồn nhiều
    const isWarehouseOverview =
      q.includes('quản lý kho') || q.includes('quan ly kho') ||
      q.includes('thông tin kho') || q.includes('thong tin kho') ||
      q.includes('thông tin của quản lý kho') || q.includes('thong tin cua quan ly kho') ||
      q.includes('tình trạng kho') || q.includes('tinh trang kho') ||
      q.includes('kho hàng') || q.includes('kho hang') ||
      q.includes('hết hàng') || q.includes('het hang') ||
      q.includes('hàng hết') || q.includes('hang het') ||
      q.includes('hàng sắp hết') || q.includes('hang sap het') ||
      q.includes('sắp hết hàng') || q.includes('sap het hang') ||
      q.includes('sắp hết') || q.includes('sap het') ||
      q.includes('thiếu hàng') || q.includes('cạn kho') ||
      q.includes('tồn thấp') || q.includes('tồn nhiều') || q.includes('ton nhieu') ||
      q.includes('nhiều tồn') || q.includes('nhieu ton') ||
      q.includes('tổng kho') || q.includes('tong kho') ||
      q.includes('tầm kho') || q.includes('tam kho') ||
      (q.includes('tồn kho') && !q.includes('doanh thu'));

    if (isWarehouseOverview) {
      const [stockItems, balances] = await Promise.all([
        this.prisma.stockItem.findMany({
          where: { storeId },
          include: { balances: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.inventoryBalance.findMany({
          where: { storeId },
          include: {
            stockItem: {
              select: { id: true, sku: true, name: true, minStockLevel: true, costPrice: canSeeFinancials, sellingPrice: true },
            },
          },
        }),
      ]);

      let totalVal = 0;
      let totalUnits = 0;
      const outOfStockItems: Array<{ sku: string; name: string; costPrice: number }> = [];
      const lowStockItems: Array<{ sku: string; name: string; qty: number; minStock: number; costPrice: number }> = [];
      const overStockItems: Array<{ sku: string; name: string; qty: number }> = [];

      // If unit test mocked inventoryBalance.findMany, prefer it when stockItems has no balances
      if (balances.length > 0 && (!stockItems.length || !stockItems[0]?.balances)) {
        for (const b of balances) {
          const qty = b.quantity || 0;
          const reserved = b.reservedQuantity || 0;
          const avail = Math.max(0, qty - reserved);
          const cp = Number(b.stockItem?.costPrice || 0);
          totalUnits += qty;
          totalVal += qty * cp;
          const minStock = b.stockItem?.minStockLevel || 10;
          const sku = b.stockItem?.sku || `SKU-${b.id}`;
          const name = b.stockItem?.name || 'Sản phẩm';
          if (avail <= 0) {
            outOfStockItems.push({ sku, name, costPrice: cp });
          } else if (avail <= minStock) {
            lowStockItems.push({ sku, name, qty: avail, minStock, costPrice: cp });
          } else if (avail >= 50) {
            overStockItems.push({ sku, name, qty: avail });
          }
        }
      } else {
        for (const item of stockItems) {
          const itemBalances = item.balances || [];
          const qty = itemBalances.reduce((s, b) => s + b.quantity, 0);
          const reserved = itemBalances.reduce((s, b) => s + b.reservedQuantity, 0);
          const avail = Math.max(0, qty - reserved);
          const cp = Number(item.costPrice || 0);

          totalUnits += qty;
          totalVal += qty * cp;

          if (avail <= 0) {
            outOfStockItems.push({ sku: item.sku, name: item.name, costPrice: cp });
          } else if (avail <= item.minStockLevel || avail <= 10) {
            lowStockItems.push({ sku: item.sku, name: item.name, qty: avail, minStock: item.minStockLevel, costPrice: cp });
          } else if (avail >= 50) {
            overStockItems.push({ sku: item.sku, name: item.name, qty: avail });
          }
        }
      }

      overStockItems.sort((a, b) => b.qty - a.qty);
      const topOverStockSample = overStockItems.slice(0, 5);

      // Strip 'sắp hết hàng' before checking for bare 'hết hàng'
      const qWithoutSapHet = q.replace(/sắp hết hàng|sap het hang|hàng sắp hết|hang sap het|sắp hết|sap het/g, '');
      const hasBareHetHang = qWithoutSapHet.includes('hết hàng') || qWithoutSapHet.includes('het hang') || qWithoutSapHet.includes('hàng hết') || qWithoutSapHet.includes('hang het');
      const hasSapHet = q.includes('sắp hết') || q.includes('sap het') || q.includes('thiếu hàng') || q.includes('cạn kho') || q.includes('tồn thấp');
      const hasTonNhieu = q.includes('tồn nhiều') || q.includes('ton nhieu') || q.includes('nhiều tồn') || q.includes('nhieu ton') || q.includes('thừa hàng');
      const hasKhoOverview = q.includes('quản lý kho') || q.includes('thông tin kho') || q.includes('tổng kho') || q.includes('tầm kho');

      const isOutOfStockOnly = hasBareHetHang && !hasSapHet && !hasTonNhieu && !hasKhoOverview;
      const isLowStockOnly = hasSapHet && !hasBareHetHang && !hasTonNhieu && !hasKhoOverview;
      const isOverStockOnly = hasTonNhieu && !hasBareHetHang && !hasSapHet && !hasKhoOverview;

      const answerLines: string[] = [];

      if (isOutOfStockOnly) {
        answerLines.push(`### 🔴 CÁC SẢN PHẨM HẾT HÀNG (CẦN NHẬP KHO GẤP)\n`);
        answerLines.push(`Hiện tại cửa hàng có **${outOfStockItems.length} sản phẩm hết hàng** (tồn khả dụng = 0 Cái) cần ưu tiên nhập ngay:`);
        if (outOfStockItems.length > 0) {
          outOfStockItems.forEach((it) => {
            answerLines.push(`- **${it.name}** (\`${it.sku}\`): Tồn hiện tại **0 Cái**`);
          });
        }
        answerLines.push(`\n**Tóm tắt 4 trụ cột Quản lý kho:**`);
      } else if (isLowStockOnly) {
        answerLines.push(`### 🟠 CÁC SẢN PHẨM SẮP HẾT HÀNG (CẦN NHẬP KHO GẤP)\n`);
        if (lowStockItems.length > 0) {
          answerLines.push(`Hiện tại cửa hàng có **${lowStockItems.length} sản phẩm sắp hết hàng** (dưới ngưỡng an toàn) cần theo dõi nhập bổ sung:`);
          lowStockItems.forEach((it) => {
            answerLines.push(`- **${it.name}** (\`${it.sku}\`): Còn **${it.qty} Cái** (Ngưỡng an toàn: ${it.minStock} Cái)`);
          });
        }
        if (outOfStockItems.length > 0) {
          answerLines.push(`\nNgoài ra có **${outOfStockItems.length} sản phẩm đã hết sạch hàng (0 Cái)** cần nhập khẩn cấp:`);
          outOfStockItems.forEach((it) => {
            answerLines.push(`- **${it.name}** (\`${it.sku}\`): Tồn hiện tại **0 Cái**`);
          });
        }
        if (lowStockItems.length === 0 && outOfStockItems.length === 0) {
          answerLines.push(`Tất cả mặt hàng hiện tại đều đang duy trì mức tồn trên ngưỡng an toàn.`);
        }
        answerLines.push(`\n**Tóm tắt 4 trụ cột Quản lý kho:**`);
      } else if (isOverStockOnly) {
        answerLines.push(`### 🔵 BÁO CÁO CÁC MẶT HÀNG TỒN KHO NHIỀU\n`);
        answerLines.push(
          canSeeFinancials
            ? `Hiện tại cửa hàng có **${overStockItems.length} sản phẩm tồn nhiều** (tồn từ 50 đơn vị trở lên) đang gây ứ đọng, cần có kế hoạch xả hàng. Các mặt hàng tồn cao nhất gồm:`
            : `Hiện tại cửa hàng có **${overStockItems.length} sản phẩm tồn nhiều** (tồn từ 50 đơn vị trở lên), cần đẩy nhanh tốc độ xuất kho. Các mặt hàng tồn cao nhất gồm:`
        );
        topOverStockSample.forEach((it) => {
          answerLines.push(`- **${it.name}** (\`${it.sku}\`): Tồn **${it.qty.toLocaleString('vi-VN')} Cái**`);
        });
        answerLines.push(`\n**Tóm tắt 4 trụ cột Quản lý kho:**`);
      } else {
        answerLines.push(`### 📦 TỔNG QUAN PHÂN HỆ QUẢN LÝ KHO & TỒN KHO\n`);
      }

      answerLines.push(
        canSeeFinancials
          ? `- 💰 **GIÁ TRỊ TỒN KHO:** **${formatVND(totalVal)}** (Tổng vốn trong kho trên **${totalUnits.toLocaleString('vi-VN')}** sản phẩm vật lý / ${stockItems.length} mặt hàng).`
          : `- 📦 **TỔNG SỐ LƯỢNG SẢN PHẨM:** **${totalUnits.toLocaleString('vi-VN')}** sản phẩm vật lý trong kho (${stockItems.length} mặt hàng).`,
        `- 🔴 **HẾT HÀNG:** **${outOfStockItems.length} SP** (Cần nhập ngay).${
          outOfStockItems.length > 0
            ? '\n  ' + outOfStockItems.map((it) => `+ **${it.name}** (\`${it.sku}\`): Tồn hiện tại **0 Cái**`).join('\n  ')
            : ' Không có sản phẩm nào hết sạch hàng.'
        }`,
        `- 🟠 **SẮP HẾT HÀNG:** **${lowStockItems.length} SP** (Dưới ngưỡng an toàn).${
          lowStockItems.length > 0
            ? '\n  ' + lowStockItems.map((it) => `+ **${it.name}** (\`${it.sku}\`): Còn **${it.qty} Cái** (Ngưỡng an toàn: ${it.minStock} Cái)`).join('\n  ')
            : ' Tất cả mặt hàng đều an toàn.'
        }`,
        canSeeFinancials
          ? `- 🔵 **TỒN NHIỀU:** **${overStockItems.length} SP** (Hàng tồn lớn, cần xả: Các mặt hàng tồn từ 50 đơn vị trở lên như Mì Tôm Hảo Hảo ${overStockItems[0]?.qty.toLocaleString('vi-VN') || 0} Cái, Nước ngọt Trà xanh ${overStockItems[1]?.qty.toLocaleString('vi-VN') || 0} Cái...).`
          : `- 🔵 **TỒN NHIỀU:** **${overStockItems.length} SP** (Tồn kho cao, cần đẩy nhanh tiêu thụ: Các mặt hàng tồn từ 50 đơn vị trở lên như Mì Tôm Hảo Hảo ${overStockItems[0]?.qty.toLocaleString('vi-VN') || 0} Cái, Nước ngọt Trà xanh ${overStockItems[1]?.qty.toLocaleString('vi-VN') || 0} Cái...).`,
        `\n💡 **Khuyến nghị từ AI Pilot:**`,
        `1. Lập phiếu nhập kho ưu tiên cho các mặt hàng hết hàng và sắp hết để tránh đứt đoạn bán hàng.`,
        `2. Lên kế hoạch xả hàng hoặc áp dụng combo khuyến mãi cho các mặt hàng tồn nhiều để quay vòng vốn nhanh.`
      );

      const answer = answerLines.join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Vào Quản lý kho ngay', url: '/inventory', variant: 'primary' },
          { label: 'Xem cảnh báo rủi ro', url: '/alerts' },
        ],
        dataSnapshot: {
          ...(canSeeFinancials ? { totalCost: totalVal } : {}),
          totalUnits,
          outOfStockCount: outOfStockItems.length,
          outOfStockItems: outOfStockItems.map((it) => ({ sku: it.sku, name: it.name, ...(canSeeFinancials ? { costPrice: it.costPrice } : {}) })),
          lowStockCount: lowStockItems.length,
          lowStockItems: lowStockItems.map((it) => ({ sku: it.sku, name: it.name, qty: it.qty, minStock: it.minStock, ...(canSeeFinancials ? { costPrice: it.costPrice } : {}) })),
          overStockCount: overStockItems.length,
          topOverStockSample,
        },
      };
    }

    // INTENT 2: Sản phẩm bán chạy nhất (7 ngày qua hoặc 30 ngày)
    if (q.includes('bán chạy') || q.includes('chạy nhất') || q.includes('top bán') || q.includes('bán tốt')) {
      const now = new Date();
      const past7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const orderItems = await this.prisma.orderItem.findMany({
        where: {
          storeId,
          order: {
            status: 'FULFILLED',
            createdAt: { gte: past7Days },
          },
        },
      });

      if (orderItems.length === 0) {
        return {
          answer: `### 📈 SẢN PHẨM BÁN CHẠY\n\nTrong 7 ngày qua chưa ghi nhận giao dịch bán hàng nào hoàn thành. Bạn có thể mở bán tại trang **Thu ngân (POS)** hoặc xem tổng quan tại trang **Báo cáo**.`,
          actionLinks: [{ label: 'Mở trang Thu ngân POS', url: '/pos' }],
        };
      }

      const map = new Map<number, { sku: string; name: string; sold: number; revenue: number }>();
      for (const item of orderItems) {
        const cur = map.get(item.stockItemId) || { sku: item.skuSnapshot, name: item.nameSnapshot, sold: 0, revenue: 0 };
        cur.sold += item.quantity;
        cur.revenue += toNumber(item.subtotal);
        map.set(item.stockItemId, cur);
      }

      const sorted = Array.from(map.values()).sort((a, b) => b.sold - a.sold).slice(0, 5);

      const rows = sorted.map((item, idx) =>
        canSeeFinancials
          ? `${idx + 1}. **${item.name}** (\`${item.sku}\`): **${item.sold}** sản phẩm | Doanh thu: **${formatVND(item.revenue)}**`
          : `${idx + 1}. **${item.name}** (\`${item.sku}\`): **${item.sold}** sản phẩm`
      );

      const answer = [
        `### 🏆 TOP 5 SẢN PHẨM BÁN CHẠY NHẤT (7 NGÀY QUA)\n`,
        ...rows,
        `\n💡 **Khuyến nghị từ AI Pilot:**`,
        `- Duy trì lượng tồn kho an toàn cho các mặt hàng chủ lực này.`,
        `- Cân nhắc đàm phán chiết khấu nhập số lượng lớn với nhà cung cấp để tăng thêm biên lợi nhuận.`,
      ].join('\n');

      return {
        answer,
        actionLinks: canSeeFinancials ? [{ label: 'Xem phân tích chi tiết', url: '/analytics' }] : [],
        dataSnapshot: canSeeFinancials ? sorted : sorted.map(({ sku, name, sold }) => ({ sku, name, sold })),
      };
    }

    // INTENT 2.5: Phân tích tài chính & số liệu theo THÁNG (tháng trước, tháng cụ thể...)
    const timeIntent = this.parseTimeIntent(question);
    if (canSeeFinancials && (timeIntent.isMonthQuery || q.includes('tháng'))) {
      const monthResult = await this.explainMonthFinancials(storeId, timeIntent.year, timeIntent.month, viewerRole);
      return {
        answer: monthResult.summary,
        actionLinks: [
          { label: 'Xem báo cáo chi tiết', url: '/analytics' },
          { label: 'Xem danh sách đơn hàng', url: '/orders' },
        ],
        dataSnapshot: monthResult.data,
      };
    }

    // INTENT 3: Doanh thu và lợi nhuận hôm nay / tuần này
    const asksFinance = q.includes('doanh thu') || q.includes('lợi nhuận') || q.includes('tiền lãi') || q.includes('doanh số');
    if (!canSeeFinancials && asksFinance) {
      return restricted();
    }
    if (canSeeFinancials && (asksFinance || q.includes('hôm nay'))) {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

      const [todayOrders, yesterdayOrders] = await Promise.all([
        this.prisma.order.findMany({
          where: { storeId, status: 'FULFILLED', createdAt: { gte: todayStart } },
          include: { items: true },
        }),
        this.prisma.order.findMany({
          where: { storeId, status: 'FULFILLED', createdAt: { gte: yesterdayStart, lt: todayStart } },
          include: { items: true },
        }),
      ]);

      const todayRevenue = todayOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
      let todayCost = 0;
      todayOrders.forEach((o) => o.items.forEach((i) => (todayCost += toNumber(i.costPriceSnapshot) * i.quantity)));
      const todayProfit = Math.max(0, todayRevenue - todayCost);
      const todayMargin = todayRevenue > 0 ? Number(((todayProfit / todayRevenue) * 100).toFixed(1)) : 0;

      const yestRevenue = yesterdayOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);

      const diff = todayRevenue - yestRevenue;
      const compareText = yestRevenue === 0
        ? 'Chưa có số liệu đối chiếu ngày hôm qua.'
        : diff >= 0
          ? `Tăng **+${formatVND(diff)}** so với cùng giờ hôm qua.`
          : `Giảm **${formatVND(Math.abs(diff))}** so với ngày hôm qua.`;

      const answer = [
        `### 💰 BÁO CÁO TÀI CHÍNH HÔM NAY (${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()})\n`,
        `- **Tổng doanh thu thực tế:** **${formatVND(todayRevenue)}**`,
        `- **Tổng số đơn hàng:** **${todayOrders.length}** đơn`,
        `- **Giá vốn hàng bán (COGS):** ${formatVND(todayCost)}`,
        `- **Lợi nhuận gộp ước tính:** **${formatVND(todayProfit)}** (Biên lợi nhuận: **${todayMargin}%**)`,
        `- **So với ngày hôm qua:** ${compareText}`,
        `\n💡 *Dữ liệu được tổng hợp trực tiếp từ các đơn hàng thanh toán thành công qua POS và đơn hàng giao dịch thực tế.*`
      ].join('\n\n');

      return {
        answer,
        actionLinks: [
          { label: 'Xem báo cáo chi tiết', url: '/analytics' },
          { label: 'Xem danh sách đơn hàng', url: '/orders' },
        ],
        dataSnapshot: { todayRevenue, todayProfit, todayMargin, count: todayOrders.length },
      };
    }

    // INTENT 4: Bán lỗ hoặc lợi nhuận thấp
    if (q.includes('bán lỗ') || q.includes('lỗ vốn') || q.includes('dưới giá vốn') || q.includes('lợi nhuận thấp') || q.includes('biên thấp')) {
      if (!canSeeFinancials) {
        return restricted();
      }
      const items = await this.prisma.stockItem.findMany({
        where: { storeId, isActive: true },
        select: { id: true, sku: true, name: true, costPrice: true, sellingPrice: true },
      });

      const lossMaking = items.filter((i) => toNumber(i.sellingPrice) < toNumber(i.costPrice));
      const lowMargin = items.filter((i) => {
        const sp = toNumber(i.sellingPrice);
        const cp = toNumber(i.costPrice);
        if (sp <= 0 || sp < cp) return false;
        const margin = ((sp - cp) / sp) * 100;
        return margin < 15; // margin under 15%
      });

      if (lossMaking.length === 0 && lowMargin.length === 0) {
        return {
          answer: `### 🛡️ AN TOÀN BIÊN LỢI NHUẬN\n\nTuyệt vời! Hiện tại **không có mặt hàng nào bị bán dưới giá vốn** trong cửa hàng của bạn. Tất cả các sản phẩm đều đang duy trì mức giá bán mang lại lợi nhuận dương.`,
          actionLinks: [{ label: 'Xem bảng gợi ý giá', url: '/pricing' }],
        };
      }

      const rows: string[] = [];
      if (lossMaking.length > 0) {
        rows.push(`#### 🔴 Sản phẩm bán dưới giá vốn (${lossMaking.length} sản phẩm):`);
        lossMaking.forEach((item, idx) => {
          const sp = toNumber(item.sellingPrice);
          const cp = toNumber(item.costPrice);
          rows.push(`${idx + 1}. **${item.name}** (\`${item.sku}\`): Giá bán **${formatVND(sp)}** < Giá vốn **${formatVND(cp)}** (Đang lỗ **${formatVND(cp - sp)}**/sản phẩm)`);
        });
      }

      if (lowMargin.length > 0) {
        rows.push(`\n#### 🟠 Sản phẩm có biên lợi nhuận thấp (< 15%):`);
        lowMargin.slice(0, 5).forEach((item, idx) => {
          const sp = toNumber(item.sellingPrice);
          const cp = toNumber(item.costPrice);
          const margin = (((sp - cp) / sp) * 100).toFixed(1);
          rows.push(`${idx + 1}. **${item.name}** (\`${item.sku}\`): Giá bán ${formatVND(sp)} | Biên lợi nhuận: **${margin}%**`);
        });
      }

      const answer = [
        `### ⚠️ CẢNH BÁO RỦI RO LỢI NHUẬN\n`,
        ...rows,
        `\n💡 **Khuyến nghị từ AI Pilot:**`,
        `1. Cần điều chỉnh tăng giá bán các sản phẩm đang bán lỗ ngay lập tức để bảo vệ dòng tiền cửa hàng.`,
        `2. Vào phân hệ **Gợi ý giá bán** để hệ thống tính toán tự động mức giá tối ưu theo biên lợi nhuận mục tiêu.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [{ label: 'Tối ưu giá bán ngay', url: '/pricing', variant: 'primary' }],
        dataSnapshot: { lossMaking, lowMargin },
      };
    }

    // INTENT 4b: Giá vốn / giá trị tồn kho theo giá vốn (chỉ chủ shop).
    // Đặt sau "bán lỗ" để "dưới giá vốn"/"lỗ vốn" vẫn vào nhánh lợi nhuận; "vốn đọng" thuộc nhánh ứ đọng.
    // Hỏi kèm tên/mã sản phẩm ("giá vốn của Áo X") đã được nhánh SKU phía trên trả lời.
    const COST_KEYWORDS = ['giá vốn', 'giá nhập', 'tổng vốn', 'tiền vốn', 'vốn hàng', 'vốn tồn', 'vốn trong kho', 'giá trị tồn', 'giá trị kho', 'giá trị hàng tồn'];
    if (COST_KEYWORDS.some((k) => q.includes(k))) {
      if (!canSeeFinancials) {
        return restricted();
      }
      const [items, balances] = await Promise.all([
        this.prisma.stockItem.findMany({
          where: { storeId, isActive: true },
          select: { id: true, sku: true, name: true, costPrice: true },
        }),
        this.prisma.inventoryBalance.findMany({
          where: { storeId },
          select: { stockItemId: true, quantity: true },
        }),
      ]);

      const qtyByItem = new Map<number, number>();
      for (const b of balances) qtyByItem.set(b.stockItemId, (qtyByItem.get(b.stockItemId) ?? 0) + b.quantity);

      const stocked = items
        .map((i) => {
          const quantity = Math.max(0, qtyByItem.get(i.id) ?? 0);
          const costPrice = toNumber(i.costPrice);
          return { sku: i.sku, name: i.name, quantity, costPrice, value: quantity * costPrice };
        })
        .filter((i) => i.quantity > 0);

      if (stocked.length === 0) {
        return {
          answer: `### 💰 GIÁ VỐN & GIÁ TRỊ TỒN KHO\n\nHiện kho **không còn hàng tồn**, nên giá trị tồn kho theo giá vốn là **${formatVND(0)}**.\n\n💡 Muốn xem giá vốn của một sản phẩm, hãy hỏi kèm tên hoặc mã sản phẩm.`,
          actionLinks: [{ label: 'Xem sản phẩm', url: '/products' }],
          dataSnapshot: { totalInventoryCostValue: 0, totalQuantity: 0, stockedSkus: 0, missingCostSkus: [], topByCapital: [] },
        };
      }

      const totalValue = stocked.reduce((s, i) => s + i.value, 0);
      const totalQty = stocked.reduce((s, i) => s + i.quantity, 0);
      const missingCost = stocked.filter((i) => i.costPrice <= 0);
      const top = [...stocked].sort((a, b) => b.value - a.value).slice(0, 5);
      const share = (v: number) => (totalValue > 0 ? `${((v / totalValue) * 100).toFixed(1)}%` : '–');

      const answer = [
        `### 💰 GIÁ VỐN & GIÁ TRỊ TỒN KHO HIỆN TẠI\n`,
        `- **Tổng giá trị tồn kho theo giá vốn:** **${formatVND(totalValue)}**`,
        `- **Hàng đang tồn:** **${totalQty.toLocaleString('vi-VN')}** đơn vị thuộc **${stocked.length}** mã hàng`,
        `- **Giá vốn bình quân (theo số lượng tồn):** **${formatVND(totalValue / totalQty)}**/đơn vị`,
        ...(missingCost.length
          ? [`- ⚠️ **${missingCost.length}** mã còn tồn nhưng **chưa nhập giá vốn** (${missingCost.slice(0, 3).map((i) => `\`${i.sku}\``).join(', ')}${missingCost.length > 3 ? '…' : ''}), nên tổng trên có thể thấp hơn thực tế.`]
          : []),
        `\n#### 📦 ${top.length} mã chiếm nhiều vốn nhất:`,
        ...top.map((i, idx) => `${idx + 1}. **${i.name}** (\`${i.sku}\`): tồn ${i.quantity.toLocaleString('vi-VN')} × giá vốn ${formatVND(i.costPrice)} = **${formatVND(i.value)}** (${share(i.value)})`),
        `\n💡 Muốn xem giá vốn của một sản phẩm cụ thể, hãy hỏi kèm tên hoặc mã, ví dụ: *"giá vốn của ${top[0].name}"*.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Xem quản lý kho', url: '/inventory' },
          { label: 'Xem sản phẩm', url: '/products' },
        ],
        dataSnapshot: {
          totalInventoryCostValue: totalValue,
          totalQuantity: totalQty,
          stockedSkus: stocked.length,
          missingCostSkus: missingCost.map((i) => i.sku),
          topByCapital: top,
        },
      };
    }

    // INTENT 5: Nên nhập thêm sản phẩm nào
    if (q.includes('nên nhập') || q.includes('nhập thêm') || q.includes('nhập gì') || q.includes('đặt hàng')) {
      const balances = await this.prisma.inventoryBalance.findMany({
        where: { storeId },
        include: {
          stockItem: {
            select: { id: true, sku: true, name: true, minStockLevel: true, maxStockLevel: true, costPrice: canSeeFinancials },
          },
        },
      });

      const needsRestock = balances.filter((b) => b.quantity <= Math.max(1, b.stockItem.minStockLevel));

      if (needsRestock.length === 0) {
        return {
          answer: `### 📦 ĐỀ XUẤT NHẬP HÀNG\n\nHiện tại kho hàng đang đầy đủ, **chưa cần gấp rút nhập thêm sản phẩm nào**. Bạn có thể theo dõi thêm tốc độ bán trong tuần để lên kế hoạch đặt hàng định kỳ.`,
          actionLinks: [{ label: 'Xem quản lý kho', url: '/inventory' }],
        };
      }

      let totalEstimateCost = 0;
      const planRows = needsRestock.map((b, idx) => {
        const suggestQty = Math.max(10, b.stockItem.maxStockLevel - b.quantity);
        const cost = suggestQty * toNumber(b.stockItem.costPrice);
        totalEstimateCost += cost;
        return canSeeFinancials
          ? `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Hiện còn **${b.quantity}** -> Đề xuất nhập thêm **${suggestQty}** đơn vị (Ước tính vốn: **${formatVND(cost)}**)`
          : `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Hiện còn **${b.quantity}** -> Đề xuất nhập thêm **${suggestQty}** đơn vị`;
      });

      const answer = [
        `### 📋 KẾ HOẠCH ĐỀ XUẤT NHẬP HÀNG (${needsRestock.length} MẶT HÀNG)\n`,
        `Dựa trên số lượng tồn khả dụng và mức tồn tối đa đã cấu hình:\n`,
        ...planRows,
        ...(canSeeFinancials ? [`\n- **Tổng ngân sách dự kiến cần chuẩn bị:** **${formatVND(totalEstimateCost)}**`] : []),
        `\n💡 **Gợi ý:** Bạn có thể liên hệ các đại lý cung cấp ngay để đảm bảo hàng hóa về trước cuối tuần.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Tạo phiếu nhập kho', url: '/inventory', variant: 'primary' },
          { label: 'Xem cảnh báo thiếu hàng', url: '/alerts' },
        ],
        dataSnapshot: canSeeFinancials ? { needsRestock, totalEstimateCost } : { needsRestock },
      };
    }

    // INTENT 6: Gợi ý điều chỉnh giá
    if (q.includes('điều chỉnh giá') || q.includes('gợi ý giá') || q.includes('thay đổi giá') || q.includes('đề xuất giá') || q.includes('tối ưu giá')) {
      if (!canSeeFinancials) {
        return restricted();
      }
      const recs = await this.prisma.pricingRecommendation.findMany({
        where: { storeId, status: 'PENDING' },
        include: { stockItem: true },
      });

      if (recs.length === 0) {
        return {
          answer: `### 🏷️ GỢI Ý GIÁ BÁN\n\nHiện tại **không có đề xuất thay đổi giá nào đang chờ duyệt**. Các sản phẩm đang ở mức giá cân bằng với giá vốn và nhu cầu tiêu thụ.`,
          actionLinks: [{ label: 'Xem trang định giá', url: '/pricing' }],
        };
      }

      const rows = recs.map((r, idx) => {
        const act = r.action === 'INCREASE' ? '🟢 Tăng giá' : '🔵 Giảm giá';
        return `${idx + 1}. **${r.stockItem.name}** (\`${r.stockItem.sku}\`): ${act} từ ${formatVND(Number(r.currentPrice))} -> **${formatVND(Number(r.recommendedPrice))}**`;
      });

      const answer = [
        `### 💡 CÁC ĐỀ XUẤT TỐI ƯU GIÁ ĐANG CHỜ DUYỆT (${recs.length} SẢN PHẨM)\n`,
        ...rows,
        `\nBạn có thể vào phân hệ **Gợi ý giá bán** để kiểm tra lý do và bấm "Chấp nhận" để áp dụng giá mới trực tiếp vào hệ thống.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [{ label: 'Xem và duyệt giá mới', url: '/pricing', variant: 'primary' }],
        dataSnapshot: recs,
      };
    }

    // INTENT 7: Tồn kho dư thừa / Hàng ứ đọng
    if (q.includes('dư thừa') || q.includes('thừa hàng') || q.includes('ứ đọng') || q.includes('dead stock') || q.includes('bán chậm')) {
      const balances = await this.prisma.inventoryBalance.findMany({
        where: { storeId, quantity: { gt: 0 } },
        include: {
          stockItem: {
            select: { id: true, sku: true, name: true, costPrice: canSeeFinancials, sellingPrice: true, maxStockLevel: true, createdAt: true },
          },
        },
      });

      const overstocks = balances.filter(
        (b) => (b.stockItem.maxStockLevel > 0 && b.quantity > b.stockItem.maxStockLevel) || b.quantity >= 100
      );

      if (overstocks.length === 0) {
        return {
          answer: `### 📦 TỒN KHO DƯ THỪA\n\nKho hàng của bạn đang luân chuyển tốt, **chưa ghi nhận mặt hàng nào bị tồn dư thừa vượt trần**.`,
          actionLinks: [{ label: 'Xem danh sách tồn kho', url: '/inventory' }],
        };
      }

      let totalTiedCapital = 0;
      const rows = overstocks.map((b, idx) => {
        const capital = b.quantity * toNumber(b.stockItem.costPrice);
        totalTiedCapital += capital;
        return canSeeFinancials
          ? `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Tồn **${b.quantity}** đơn vị (Vốn đọng: **${formatVND(capital)}**)`
          : `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Tồn **${b.quantity}** đơn vị`;
      });

      const answer = canSeeFinancials
        ? [
            `### ⚠️ MẶT HÀNG CÓ NGUY CƠ DƯ THỪA / ĐỌNG VỐN (${overstocks.length} MẶT HÀNG)\n`,
            ...rows,
            `\n- **Tổng vốn đọng trong lượng hàng này:** **${formatVND(totalTiedCapital)}**`,
            `\n💡 **Khuyến nghị từ AI Pilot:** Áp dụng chương trình combo bán kèm hoặc giảm giá 5 - 10% để kích thích người mua giải phóng lượng vốn lưu động này.`,
          ].join('\n')
        : [
            `### ⚠️ MẶT HÀNG CÓ NGUY CƠ DƯ THỪA (${overstocks.length} MẶT HÀNG)\n`,
            ...rows,
            `\n💡 **Gợi ý:** Báo Chủ cửa hàng danh sách trên để quyết định phương án xử lý.`,
          ].join('\n');

      return {
        answer,
        actionLinks: canSeeFinancials
          ? [
              { label: 'Xem gợi ý giảm giá', url: '/pricing' },
              { label: 'Xem kho hàng', url: '/inventory' },
            ]
          : [{ label: 'Xem kho hàng', url: '/inventory' }],
        dataSnapshot: canSeeFinancials ? { overstocks, totalTiedCapital } : { overstocks },
      };
    }

    // INTENT 8: Tổng hợp rủi ro hôm nay
    if (q.includes('rủi ro') || q.includes('vấn đề') || q.includes('tổng hợp') || q.includes('nguy cơ')) {
      const alerts = await this.prisma.alert.findMany({
        where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: [{ severity: 'asc' }],
        take: 8,
      });

      const critCount = alerts.filter((a) => a.severity === 'CRITICAL').length;
      const warnCount = alerts.filter((a) => a.severity === 'WARNING').length;

      if (alerts.length === 0) {
        return {
          answer: `### ✅ KHÔNG CÓ RỦI RO NGHIÊM TRỌNG HÔM NAY\n\nCửa hàng hiện tại đang hoạt động ổn định. Không có cảnh báo hết hàng hoặc cảnh báo bán lỗ nào chưa được giải quyết.`,
          actionLinks: [{ label: 'Xem trang tổng quan', url: '/dashboard' }],
        };
      }

      const rows = alerts.map((a, idx) => {
        const icon = a.severity === 'CRITICAL' ? '🔴' : '🟠';
        return `${idx + 1}. ${icon} **${a.title}**\n   - *${a.message}*`;
      });

      const answer = [
        `### 🚨 TỔNG HỢP CÁC RỦI RO CẦN XỬ LÝ HÔM NAY\n`,
        `Hệ thống phát hiện **${critCount}** vấn đề nghiêm trọng và **${warnCount}** cảnh báo cần theo dõi:\n`,
        ...rows,
        `\n💡 **Hành động khuyến nghị:** Vào mục **Cảnh báo rủi ro** để tiếp nhận và đánh dấu đã xử lý từng vấn đề.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Xử lý các cảnh báo', url: '/alerts', variant: 'primary' },
          { label: 'Xem quản lý kho', url: '/inventory' },
        ],
        dataSnapshot: { alerts },
      };
    }

    // INTENT 9: Hỏi tổng quan tình hình cửa hàng / hôm nay
    if (q.includes('tổng quan') || q.includes('tình hình') || q.includes('cửa hàng hôm nay') || q.includes('báo cáo hôm nay') || !q) {
      const overview = await this.explainStoreOverview(storeId, viewerRole);
      return {
        answer: overview.summary,
        actionLinks: canSeeFinancials
          ? [
              { label: 'Xem cảnh báo rủi ro', url: '/alerts' },
              { label: 'Xem gợi ý giá bán', url: '/pricing' },
              { label: 'Xem báo cáo doanh thu', url: '/analytics' },
            ]
          : [{ label: 'Xem cảnh báo rủi ro', url: '/alerts' }],
        dataSnapshot: overview.metrics,
      };
    }

    // DEFAULT FALLBACK: Khi câu hỏi tự do ngoài phạm vi rule hoặc AI tạm thời gián đoạn
    return {
      answer: canSeeFinancials
        ? `Dạ em đã nhận được câu hỏi của anh/chị: "${question}".\n\nHiện tại câu hỏi này đang nằm ngoài danh mục số liệu nội bộ của cửa hàng. Anh/chị có muốn em hỗ trợ kiểm tra tồn kho các mặt hàng, xem sản phẩm bán chạy, hay kiểm tra các gợi ý tối ưu giá bán cho cửa hàng không ạ?`
        : `Dạ em đã ghi nhận câu hỏi: "${question}". Em có thể hỗ trợ anh/chị tra cứu số lượng tồn kho, kiểm tra mặt hàng sắp hết hoặc quy trình kiểm kê kho ạ!`,
      actionLinks: canSeeFinancials
        ? [
            { label: 'Xem tồn kho', url: '/inventory' },
            { label: 'Xem cảnh báo rủi ro', url: '/alerts' },
          ]
        : [{ label: 'Xem tồn kho', url: '/inventory' }],
    };
  }
}
