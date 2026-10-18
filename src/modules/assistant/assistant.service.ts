import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { DecisionEngineService } from '../decision-engine/decision-engine.service';
import { toNumber } from '../../common/utils/decimal';

function formatVND(n: number): string {
  return Math.round(n).toLocaleString('vi-VN') + ' đ';
}

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
        action: true,
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
      coverage: analysis.coverage,
      risk: analysis.risk,
      confidence: analysis.confidence,
      engineConfig: analysis.engineConfig,
      activeAlerts: alerts,
      pricingRecommendation: recommendation,
    };

    const paragraphs: string[] = [];
    paragraphs.push(
      `### Phân tích chi tiết: ${analysis.productName} (Mã: ${analysis.sku})\n\n` +
      `- **Tồn kho khả dụng:** **${analysis.inventory.available}** đơn vị (Tổng tồn thực tế: ${analysis.inventory.onHand}, Đang giữ chỗ: ${analysis.inventory.reserved})\n` +
      `- **Giá bán:** ${formatVND(analysis.pricing.sellingPrice)} | **Giá vốn:** ${formatVND(analysis.pricing.costPrice)} | **Biên lợi nhuận:** **${analysis.pricing.expectedMarginPct}%**\n` +
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
        `⚠️ **HÀNG TỒN Ứ ĐỌNG (DEAD STOCK):** Không ghi nhận lượt bán trong ${analysis.risk.daysSinceLastSale ?? 90} ngày qua, làm đọng khoảng **${formatVND(analysis.risk.deadStockCostValue)}** vốn.`
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
  async explainStoreOverview(storeId: number) {
    const overview = await this.decisionEngineService.getOverview(storeId, {
      riskFilter: 'ALL',
      page: 1,
      limit: 100,
    });

    const openAlertsCount = await this.prisma.alert.count({
      where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });

    const pendingRecsCount = await this.prisma.pricingRecommendation.count({
      where: { storeId, status: 'PENDING' },
    });

    const summaryText = [
      `### 📊 TỔNG QUAN TÌNH HÌNH CỬA HÀNG HÔM NAY`,
      `- **Tổng số sản phẩm đang quản lý:** **${overview.summary.totalSkus}** SP`,
      `- **Mặt hàng có nguy cơ thiếu/hết hàng:** **${overview.summary.stockoutRiskCount}** SP (Cần ưu tiên nhập)`,
      `- **Mặt hàng tồn kho quá mức:** **${overview.summary.overstockRiskCount}** SP`,
      `- **Mặt hàng ứ đọng (Dead Stock):** **${overview.summary.deadStockCount}** SP (Vốn đọng: **${formatVND(overview.summary.totalDeadStockCostValue)}**)`,
      `- **Cảnh báo rủi ro đang mở:** **${openAlertsCount}** cảnh báo`,
      `- **Gợi ý tối ưu giá chờ duyệt:** **${pendingRecsCount}** đề xuất`,
      `\n💡 *Gợi ý thao tác: Bạn có thể vào tab "Cảnh báo rủi ro" để xử lý các mặt hàng hết hàng hoặc tab "Gợi ý giá bán" để duyệt các mức giá mới tối ưu lợi nhuận.*`
    ].join('\n\n');

    return {
      storeId,
      summary: summaryText,
      metrics: overview.summary,
      openAlertsCount,
      pendingRecommendationsCount: pendingRecsCount,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Main AI Pilot natural language processing engine that maps questions to database facts.
   */
  async answerQuestion(storeId: number, question: string, targetStockItemId?: number): Promise<{
    answer: string;
    actionLinks?: Array<{ label: string; url: string; variant?: string }>;
    dataSnapshot?: any;
  }> {
    const q = (question || '').toLowerCase().trim();

    // Direct SKU explanation if stockItemId provided
    if (targetStockItemId) {
      const skuResult = await this.explainSku(storeId, targetStockItemId, question);
      return {
        answer: skuResult.explanation,
        actionLinks: [
          { label: 'Kiểm tra tồn kho', url: `/inventory?search=${encodeURIComponent(skuResult.sku)}` },
          { label: 'Xem đề xuất giá', url: `/pricing?search=${encodeURIComponent(skuResult.sku)}` },
        ],
        dataSnapshot: skuResult.factualContext,
      };
    }

    // Check if user is asking about a specific SKU/product by code or name
    const allStockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true },
      select: { id: true, sku: true, name: true, costPrice: true, sellingPrice: true },
    });

    const mentionedItem = allStockItems.find(
      (item) => q.includes(item.sku.toLowerCase()) || q.includes(item.name.toLowerCase())
    );

    if (mentionedItem && (q.includes('giá') || q.includes('tồn') || q.includes('sản phẩm') || q.includes('thế nào') || q.includes('bao nhiêu'))) {
      const skuResult = await this.explainSku(storeId, mentionedItem.id, question);
      return {
        answer: skuResult.explanation,
        actionLinks: [
          { label: 'Xem sản phẩm', url: `/products?search=${encodeURIComponent(mentionedItem.sku)}` },
          { label: 'Xem đề xuất giá', url: `/pricing?search=${encodeURIComponent(mentionedItem.sku)}` },
        ],
        dataSnapshot: skuResult.factualContext,
      };
    }

    // INTENT 1: Sắp hết hàng / hết hàng
    if (q.includes('hết hàng') || q.includes('sắp hết') || q.includes('thiếu hàng') || q.includes('cạn kho') || q.includes('tồn thấp')) {
      const balances = await this.prisma.inventoryBalance.findMany({
        where: { storeId },
        include: {
          stockItem: {
            select: { id: true, sku: true, name: true, minStockLevel: true, costPrice: true, sellingPrice: true },
          },
        },
      });

      const lowStockItems = balances.filter((b) => b.quantity <= Math.max(1, b.stockItem.minStockLevel));

      if (lowStockItems.length === 0) {
        return {
          answer: `### ✅ TÌNH TRẠNG KHO HÀNG AN TOÀN\n\nHiện tại **không có sản phẩm nào chạm ngưỡng hết hàng hoặc dưới điểm đặt hàng tối thiểu** trong cửa hàng của bạn. Tất cả các mặt hàng đều duy trì mức tồn trên ngưỡng an toàn.`,
          actionLinks: [{ label: 'Xem danh sách tồn kho', url: '/inventory' }],
        };
      }

      const rows = lowStockItems.map((item, idx) => {
        const status = item.quantity <= 0 ? '🔴 **HẾT HÀNG (0)**' : `🟠 Tồn thấp: **${item.quantity}** (Ngưỡng: ${item.stockItem.minStockLevel})`;
        return `${idx + 1}. **${item.stockItem.name}** (Mã: \`${item.stockItem.sku}\`)\n   - Tình trạng: ${status}\n   - Giá vốn: ${formatVND(toNumber(item.stockItem.costPrice))} | Giá bán: ${formatVND(toNumber(item.stockItem.sellingPrice))}`;
      });

      const answer = [
        `### ⚠️ CÁC SẢN PHẨM CẦN NHẬP KHO GẤP (${lowStockItems.length} MẶT HÀNG)\n`,
        `Hệ thống phát hiện các mặt hàng sau đang có số lượng tồn kho bằng 0 hoặc thấp hơn ngưỡng an toàn tối thiểu:\n`,
        ...rows,
        `\n💡 **Khuyến nghị từ AI Pilot:**`,
        `1. Lập đơn nhập hàng ngay trong ngày cho các mặt hàng trên để tránh bỏ lỡ khách mua hàng.`,
        `2. Bạn có thể vào phân hệ **Quản lý kho -> Nhập kho** để thêm số lượng khi hàng về.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Vào nhập kho ngay', url: '/inventory', variant: 'primary' },
          { label: 'Xem chi tiết cảnh báo', url: '/alerts' },
        ],
        dataSnapshot: { count: lowStockItems.length, items: lowStockItems },
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
        `${idx + 1}. **${item.name}** (\`${item.sku}\`): **${item.sold}** sản phẩm | Doanh thu: **${formatVND(item.revenue)}**`
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
        actionLinks: [{ label: 'Xem phân tích chi tiết', url: '/analytics' }],
        dataSnapshot: sorted,
      };
    }

    // INTENT 3: Doanh thu và lợi nhuận hôm nay / tuần này
    if (q.includes('doanh thu') || q.includes('lợi nhuận') || q.includes('tiền lãi') || q.includes('hôm nay') || q.includes('doanh số')) {
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

    // INTENT 5: Nên nhập thêm sản phẩm nào
    if (q.includes('nên nhập') || q.includes('nhập thêm') || q.includes('nhập gì') || q.includes('đặt hàng')) {
      const balances = await this.prisma.inventoryBalance.findMany({
        where: { storeId },
        include: {
          stockItem: {
            select: { id: true, sku: true, name: true, minStockLevel: true, maxStockLevel: true, costPrice: true },
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
        return `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Hiện còn **${b.quantity}** -> Đề xuất nhập thêm **${suggestQty}** đơn vị (Ước tính vốn: **${formatVND(cost)}**)`;
      });

      const answer = [
        `### 📋 KẾ HOẠCH ĐỀ XUẤT NHẬP HÀNG (${needsRestock.length} MẶT HÀNG)\n`,
        `Dựa trên số lượng tồn khả dụng và mức tồn tối đa đã cấu hình:\n`,
        ...planRows,
        `\n- **Tổng ngân sách dự kiến cần chuẩn bị:** **${formatVND(totalEstimateCost)}**`,
        `\n💡 **Gợi ý:** Bạn có thể liên hệ các đại lý cung cấp ngay để đảm bảo hàng hóa về trước cuối tuần.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Tạo phiếu nhập kho', url: '/inventory', variant: 'primary' },
          { label: 'Xem cảnh báo thiếu hàng', url: '/alerts' },
        ],
        dataSnapshot: { needsRestock, totalEstimateCost },
      };
    }

    // INTENT 6: Gợi ý điều chỉnh giá
    if (q.includes('điều chỉnh giá') || q.includes('gợi ý giá') || q.includes('thay đổi giá') || q.includes('đề xuất giá') || q.includes('tối ưu giá')) {
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
            select: { id: true, sku: true, name: true, costPrice: true, sellingPrice: true, maxStockLevel: true, createdAt: true },
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
        return `${idx + 1}. **${b.stockItem.name}** (\`${b.stockItem.sku}\`): Tồn **${b.quantity}** đơn vị (Vốn đọng: **${formatVND(capital)}**)`;
      });

      const answer = [
        `### ⚠️ MẶT HÀNG CÓ NGUY CƠ DƯ THỪA / ĐỌNG VỐN (${overstocks.length} MẶT HÀNG)\n`,
        ...rows,
        `\n- **Tổng vốn đọng trong lượng hàng này:** **${formatVND(totalTiedCapital)}**`,
        `\n💡 **Khuyến nghị từ AI Pilot:** Áp dụng chương trình combo bán kèm hoặc giảm giá 5 - 10% để kích thích người mua giải phóng lượng vốn lưu động này.`,
      ].join('\n');

      return {
        answer,
        actionLinks: [
          { label: 'Xem gợi ý giảm giá', url: '/pricing' },
          { label: 'Xem kho hàng', url: '/inventory' },
        ],
        dataSnapshot: { overstocks, totalTiedCapital },
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

    // DEFAULT FALLBACK: General store-wide overview
    const overview = await this.explainStoreOverview(storeId);
    return {
      answer: overview.summary,
      actionLinks: [
        { label: 'Xem cảnh báo rủi ro', url: '/alerts' },
        { label: 'Xem gợi ý giá bán', url: '/pricing' },
        { label: 'Xem báo cáo doanh thu', url: '/analytics' },
      ],
      dataSnapshot: overview.metrics,
    };
  }
}
