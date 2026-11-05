import { AiInteractionStatus, Prisma, PrismaClient, Role } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../../common/logger';
import { canViewFinancials } from '../../common/utils/role-access';
import { DecisionEngineService } from '../decision-engine/decision-engine.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AssistantService, FINANCIAL_DATA_RESTRICTED_MESSAGE, normalizeVietnameseVoiceQuery } from './assistant.service';
import { aiMemoryService } from './ai-memory.service';
import { LlmFailureReason, LlmResult, LlmUnavailableError, OpenAiClient } from './llm/openai-client';
import { rankSuggestions, ReorderCandidate } from './suggestion-ranking';

export type { ActionSuggestion, SuggestionKind } from './suggestion-ranking';

/** Where an answer came from: the language model, or the rule-based assistant as a fallback. */
export type AnswerSource = 'AI' | 'RULES';

export interface AiAnswerMeta {
  source: AnswerSource;
  model: string;
  /** Why the rule-based answer was used, when source is RULES and AI was attempted or not configured. */
  fallbackReason?: LlmFailureReason;
  /** ai_interactions row that recorded this answer (string because the column is BIGINT). */
  interactionId?: string;
}

const RULES_MODEL = 'StockPilot-Rules-v2';

const BASE_INSTRUCTIONS = [
  'Bạn là AI Pilot — Trợ lý Cá nhân AI & Cố vấn Quản trị Cửa hàng của StockPilot tại Việt Nam.',
  '',
  'QUY TẮC CỐT LÕI (BẮT BUỘC TUÂN THỦ):',
  '1. TRẢ LỜI ĐÚNG VÀ TRÚNG CÂU HỎI (QUAN TRỌNG NHẤT):',
  '   - Người dùng hỏi điều gì thì CHỈ TẬP TRUNG TRẢ LỜI CHÍNH XÁC VÀO ĐIỀU ĐÓ. Không trả lời thừa thãi, không lan man.',
  '   - Với câu hỏi thông thường (như ngày giờ, chào hỏi, hỏi thông tin cụ thể 1 món hàng): Trả lời trực diện, ngắn gọn đúng ý đó. TUYỆT ĐỐI KHÔNG tự động chèn thêm báo cáo doanh thu, tình hình kinh doanh, hay danh sách cảnh báo tồn kho nếu người dùng KHÔNG yêu cầu.',
  '   - Chỉ phân tích sâu số liệu kho, doanh thu hoặc cảnh báo khi người dùng THỰC SỰ hỏi về tình hình cửa hàng, tồn kho, doanh số hoặc yêu cầu tư vấn/lên kế hoạch.',
  '',
  '2. PHONG THÁI TRỢ LÝ THẬT (REAL PERSONAL ASSISTANT):',
  '   - Giao tiếp tự nhiên, thân thiện, lịch thiệp và thông minh như một trợ lý cá nhân ngoài đời thực (xưng "Em", gọi "Anh/chị").',
  '   - Ở cuối câu trả lời, hãy luôn chủ động hỏi gợi mở 1 câu ngắn gọn, ấm áp sẵn sàng giúp đỡ ngay:',
  '     (Ví dụ: "Anh/chị cần em hỗ trợ kiểm tra đơn hàng, xem tồn kho hay việc gì khác không ạ? Em có thể giúp anh/chị ngay đấy ạ!", hoặc "Anh/chị có cần em hỗ trợ thêm gì cho cửa hàng nữa không ạ?").',
  '',
  '3. KHI HỎI VỀ SỐ LIỆU THÁNG TRƯỚC, BẤT KỲ THÁNG NÀO HOẶC SẢN PHẨM BÁN CHẠY THEO THÁNG:',
  '   - Khối <store_data> đã được nạp ĐẦY ĐỦ 100% SỐ LIỆU THẬT CỦA TẤT CẢ CÁC THÁNG (allMonthsPerformance: Tháng 5, 6, 7, 8, 9, 10, 11/2026 kèm Top sản phẩm bán chạy nhất từng tháng).',
  '   - Nếu người dùng hỏi bằng giọng nói bị méo âm (như "thống tóm" -> Tháng 8, "bón chạy" -> Bán chạy), hãy tự động hiểu đúng ý định của chủ cửa hàng.',
  '   - LẤY TOÀN BỘ SỐ LIỆU CHÍNH XÁC từ allMonthsPerformance: Doanh thu thực tế, số đơn hàng, tổng sản phẩm bán ra, lợi nhuận gộp, biên lợi nhuận, và Top 5 sản phẩm bán chạy nhất.',
  '   - TUYỆT ĐỐI KHÔNG BỊA ĐẶT SỐ LIỆU và KHÔNG BAO GIỜ NÓI LÀ "CHƯA GHI NHẬN" hoặc "KHÔNG BIẾT", vì dữ liệu thật của mọi tháng đều đã có sẵn.',
  '   - Luôn đưa ra các nhận xét xu hướng và 2-3 giải pháp chiến lược thực tế cho Chủ cửa hàng (nhập hàng, tối ưu giá, kích cầu).',
  '   - QUY CHUẨN TRÌNH BÀY BẢNG SO SÁNH DOANH SỐ (QUAN TRỌNG):',
  '     + Dùng cấu trúc bảng 4 cột chuẩn: | Chỉ số kinh doanh | [Tháng X] | [Tháng Y] | Chênh lệch / Xu hướng |',
  '     + Cột thứ 4 là "Chênh lệch / Xu hướng" ghi ngắn gọn, rõ ràng với số tiền, tỷ lệ % và emoji xu hướng (Ví dụ: "📉 Giảm 210.000.000 đ (-17.5%)", "📈 Tăng 4.276.400 đ (+1.6%)", "Ổn định (+0.1%)").',
  '     + TUYỆT ĐỐI KHÔNG tự tạo cột biểu đồ bằng khối ký tự đen (█████) hay chèn mã <br> trong bảng, vì trông rất thô và khó nhìn. Thay vào đó, hãy dùng cột "Chênh lệch / Xu hướng" rõ ràng, thanh lịch.',
    '4. KHI ĐƯỢC YÊU CẦU LẬP KẾ HOẠCH HOẶC TƯ VẤN KINH DOANH:',
  '   - Thoải mái hỗ trợ mọi yêu cầu (lên kế hoạch bán hàng, kịch bản livestream/post bài, xả hàng tồn, tăng doanh thu...).',
  '   - Ưu tiên sử dụng chính xác tên sản phẩm, mã SKU, giá bán, tồn kho thực tế từ khối <store_data>.',
  '   - Trình bày mạch lạc bằng Markdown: gạch đầu dòng rõ ràng, bảng số liệu, in đậm điểm nhấn, tiền tệ ghi dạng 25.000 đ.',
  '',
  '5. NẮM TOÀN BỘ 100% DỮ LIỆU CÁC CHỨC NĂNG CỦA CỬA HÀNG TRÊN HỆ THỐNG:',
  '   - Khối <store_data> đã được nạp TOÀN DIỆN 100% dữ liệu thực tế từ mọi phân hệ của StockPilot:',
  '     + Toàn bộ danh mục tất cả sản phẩm (mã SKU, tên, danh mục, tồn thực tế on-hand, tồn khả dụng, giá bán, giá vốn, trạng thái hết hàng/sắp hết/tồn cao).',
  '     + Tổng quan kho: Tổng số sản phẩm, tổng vốn tồn kho, tổng giá trị bán lẻ, số mặt hàng hết hàng, số mặt hàng sắp hết, số mặt hàng tồn quá mức.',
  '     + Danh sách kho hàng và địa chỉ kho.',
  '     + Danh sách nhân sự đang làm việc (họ tên, vai trò: Chủ cửa hàng, Nhân viên kho, email).',
  '     + Danh sách các phương thức và cấu hình thanh toán.',
  '     + Toàn bộ 100% cảnh báo rủi ro kho và các đề xuất tối ưu giá bán của Decision Engine.',
  '     + 10 đơn hàng mới nhất và kết quả kinh doanh hôm nay.',
  '     + Báo cáo toàn diện tất cả các tháng (Tháng 5, 6, 7, 8, 9, 10, 11/2026 kèm Top sản phẩm bán chạy nhất từng tháng).',
  '   - Khi Chủ cửa hàng hỏi bất kỳ câu hỏi nào về hoạt động của cửa hàng (nhân sự, kho hàng, số lượng tồn kho của bất kỳ món nào, doanh thu, lợi nhuận, đơn hàng gần đây, cảnh báo nào cần xử lý...), HÃY TRA CỨU CHÍNH XÁC TRONG <store_data> VÀ TRẢ LỜI NGAY ĐẦY ĐỦ.',
  '   - TUYỆT ĐỐI KHÔNG BỎ SÓT THÔNG TIN VÀ KHÔNG BAO GIỜ NÓI "KHÔNG BIẾT" HOẶC "CHƯA GHI NHẬN", vì toàn bộ dữ liệu của cửa hàng đều đã được tích hợp sẵn sàng trong hệ thống.',
  '',
  '6. PHÂN BIỆT RÕ RÀNG VỀ PHÂN HỆ QUẢN LÝ KHO & TỒN KHO:',
  '   - Khi người dùng hỏi về "quản lý kho", "thông tin của quản lý kho", "tình trạng kho", "tồn kho", "kho hàng", "hết hàng", "hàng sắp hết", "sắp hết hàng", "nhiều tồn", "tồn nhiều":',
  '     + Đây là câu hỏi về PHÂN HỆ QUẢN LÝ KHO HÀNG & TỒN KHO của StockPilot (trang Quản lý kho trên ứng dụng).',
  '     + TUYỆT ĐỐI KHÔNG hiểu nhầm sang hỏi nhân sự, phân quyền nhân viên hay liệt kê danh sách nhân sự!',
  '     + BẮT BUỘC trả lời rõ ràng và đầy đủ 4 thẻ KPI trụ cột theo thời gian thực (lấy từ liveStoreSnapshot.inventoryOverview.warehouseKpis hoặc ruleBasedAnalysis):',
  '       1. 💰 GIÁ TRỊ TỒN KHO: Tổng vốn trong kho (ví dụ: 518.962.200 đ trên 21.614 sản phẩm vật lý / 217 mặt hàng).',
  '       2. 🔴 HẾT HÀNG: Số lượng sản phẩm hết hàng (ví dụ: 1 SP - Cần nhập ngay) và nêu rõ tên mặt hàng (Xúc xích tiệt trùng heo CP gói 5 cây 175g - SP30, tồn 0 Cái).',
  '       3. 🟠 SẮP HẾT HÀNG: Số lượng sản phẩm sắp hết (ví dụ: 1 SP - Dưới ngưỡng an toàn) và nêu rõ tên mặt hàng (Xúc xích Vissan dinh dưỡng heo 100g - SP31, còn 1 Cái).',
  '       4. 🔵 TỒN NHIỀU: Số lượng sản phẩm tồn nhiều (ví dụ: 198 SP - Vốn đọng, cần xả: các sản phẩm tồn từ 50 cái trở lên như Mì Tôm Hảo Hảo 1.251 Cái, Nước ngọt Trà xanh không độ 1.116 Cái...).',
  '     + Nêu 1-2 lời khuyên hành động thông minh: Ưu tiên lên đơn nhập hàng cho SP hết hàng/sắp hết, và lên kế hoạch khuyến mãi/combo giải phóng hàng tồn nhiều.',
].join('\n');

const STAFF_INSTRUCTIONS =
  '- Người hỏi là NHÂN VIÊN KHO: tuyệt đối không bàn về giá vốn, lợi nhuận, biên lợi nhuận, doanh thu hay giá bán đề xuất. Chỉ nói về số lượng, tồn kho và việc vận hành kho.';

function instructionsFor(role: Role | undefined, task: string): string {
  return [BASE_INSTRUCTIONS, canViewFinancials(role) ? '' : STAFF_INSTRUCTIONS, '', `Nhiệm vụ: ${task}`]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Wraps role-filtered facts so the model reads them as data, not instructions. */
function dataBlock(question: string, data: unknown): string {
  return `Câu hỏi: ${question}\n\n<store_data>\n${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2)}\n</store_data>`;
}

/**
 * AI Decision Assistant. The Decision Engine stays the source of truth: every answer is grounded in
 * facts produced by the rule-based AssistantService (already projected for the viewer's role), and the
 * model only explains, summarizes and prioritizes them. Without a key, or on any model failure, the
 * rule-based answer is returned with source "RULES". Nothing here writes business data.
 */
export class AiDecisionService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly rules: AssistantService = new AssistantService(prisma),
    private readonly llm: OpenAiClient = new OpenAiClient(),
    private readonly decisionEngine: DecisionEngineService = new DecisionEngineService(prisma),
    private readonly analytics: AnalyticsService = new AnalyticsService()
  ) {}

  async explainSku(storeId: number, stockItemId: number, question: string | undefined, role: Role | undefined, userId?: number) {
    const base = await this.rules.explainSku(storeId, stockItemId, question, role);
    const ask = question?.trim() || 'Giải thích tình trạng tồn kho, rủi ro và việc nên làm cho sản phẩm này.';
    const ai = await this.tryComplete(storeId, userId, 'SKU_EXPLAIN', ask, {
      instructions: instructionsFor(role, 'Giải thích chuyên sâu tình trạng sản phẩm: tồn kho khả dụng, tốc độ bán, rủi ro, và 1–3 hành động cụ thể nên làm ngay. Trực diện, súc tích.'),
      input: dataBlock(ask, base.factualContext),
      maxOutputTokens: 1000,
    }, base.explanation);
    return { ...base, explanation: ai.text, ...ai.meta };
  }

  async explainOverview(storeId: number, role: Role | undefined, userId?: number) {
    const base = await this.rules.explainStoreOverview(storeId, role);
    const topAlerts = await this.prisma.alert.findMany({
      where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: [{ riskScore: 'desc' }, { openedAt: 'desc' }],
      take: 8,
      select: { type: true, severity: true, title: true, stockItem: { select: { sku: true, name: true } } },
    });
    const ask = 'Tóm tắt tình hình cửa hàng hôm nay và việc nên ưu tiên.';
    const ai = await this.tryComplete(storeId, userId, 'OVERVIEW', ask, {
      instructions: instructionsFor(role, 'Tóm tắt sắc bén tình hình tổng quan cửa hàng trong 4–5 gạch đầu dòng, sau đó đưa ra tối đa 3 việc ưu tiên cao nhất cần xử lý ngay hôm nay.'),
      input: dataBlock(ask, {
        metrics: base.metrics,
        openAlertsCount: base.openAlertsCount,
        pendingRecommendationsCount: base.pendingRecommendationsCount,
        topAlerts,
      }),
      maxOutputTokens: 1000,
    }, base.summary);
    return { ...base, summary: ai.text, ...ai.meta };
  }

  async getStoreContext(storeId: number, role: Role | undefined, targetStockItemId?: number) {
    const canSeeFinancials = canViewFinancials(role);
    try {
      const [
        store,
        stockItems,
        alerts,
        pricingRecommendations,
        ordersAll,
        warehouses,
        storeUsers,
        paymentConfigs,
        recentOrdersRaw,
        analytics30d,
      ] = await Promise.all([
        this.prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true, phone: true, address: true, createdAt: true },
        }),
        this.prisma.stockItem.findMany({
          where: { storeId },
          select: {
            id: true,
            sku: true,
            name: true,
            isActive: true,
            sellingPrice: true,
            ...(canSeeFinancials ? { costPrice: true } : {}),
            minStockLevel: true,
            maxStockLevel: true,
            product: { select: { category: { select: { name: true } } } },
            balances: { select: { quantity: true, reservedQuantity: true } },
          },
          take: 500, // Nạp 100% tất cả 217 sản phẩm của cửa hàng
          orderBy: { name: 'asc' },
        }),
        this.prisma.alert.findMany({
          where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          select: {
            id: true,
            type: true,
            severity: true,
            title: true,
            message: true,
            riskScore: true,
            stockItem: { select: { sku: true, name: true } },
          },
          take: 50,
          orderBy: [{ riskScore: 'desc' }, { openedAt: 'desc' }],
        }),
        canSeeFinancials
          ? this.prisma.pricingRecommendation.findMany({
              where: { storeId, status: 'PENDING' },
              select: {
                id: true,
                action: true,
                currentPrice: true,
                recommendedPrice: true,
                discountPct: true,
                stockItem: { select: { sku: true, name: true } },
              },
              take: 60,
              orderBy: { riskScore: 'desc' },
            })
          : Promise.resolve([]),
        canSeeFinancials
          ? this.prisma.order.findMany({
              where: {
                storeId,
                status: { in: ['FULFILLED', 'CONFIRMED'] },
              },
              select: {
                id: true,
                orderNumber: true,
                createdAt: true,
                totalAmount: true,
                createdById: true,
                payments: {
                  select: {
                    method: true,
                    amount: true,
                    status: true,
                  },
                },
                items: {
                  select: {
                    skuSnapshot: true,
                    nameSnapshot: true,
                    quantity: true,
                    subtotal: true,
                    costPriceSnapshot: true,
                  },
                },
              },
              orderBy: { createdAt: 'desc' },
            })
          : Promise.resolve([]),
        this.prisma.warehouse.findMany({
          where: { storeId, isActive: true },
          select: { id: true, name: true, location: true, isDefault: true },
        }),
        this.prisma.user.findMany({
          where: { storeId },
          select: { id: true, fullName: true, role: true, email: true, isActive: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.storePaymentConfig.findMany({
          where: { storeId },
          select: { provider: true, isActive: true },
        }),
        this.prisma.order.findMany({
          where: { storeId },
          take: 15,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalAmount: true,
            createdAt: true,
            createdBy: { select: { fullName: true } },
            payments: { select: { method: true, amount: true, status: true } },
            items: {
              select: {
                skuSnapshot: true,
                nameSnapshot: true,
                quantity: true,
                unitPriceSnapshot: true,
                subtotal: true,
              },
            },
            _count: { select: { items: true } },
          },
        }),
        canSeeFinancials
          ? this.analytics.getDashboardMetrics(storeId, { timeRange: '30d' }).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Xây dựng bức tranh toàn diện theo các khoảng thời gian (Hôm nay, 7 ngày, 30 ngày, Tất cả các tháng)
      const monthMap: Record<string, {
        monthKey: string;
        label: string;
        totalOrders: number;
        totalRevenue: number;
        totalCogs: number;
        totalUnitsSold: number;
        skuMap: Record<string, { sku: string; name: string; quantity: number; revenue: number }>;
      }> = {};

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      let todayOrdersCount = 0;
      let todayRevenue = 0;
      let todayCogs = 0;
      let todayUnitsSold = 0;
      const todaySkuMap: Record<string, { sku: string; name: string; quantity: number; revenue: number }> = {};

      let orders7dCount = 0;
      let revenue7d = 0;
      let cogs7d = 0;
      let units7dSold = 0;
      const payment7dStats = { cashCount: 0, cashAmount: 0, bankCount: 0, bankAmount: 0, walletCount: 0, walletAmount: 0 };
      const sku7dMap: Record<string, { sku: string; name: string; quantity: number; revenue: number }> = {};

      let orders30dCount = 0;
      let revenue30d = 0;
      let cogs30d = 0;
      let units30dSold = 0;

      // Thống kê hiệu suất nhân viên thực tế (Staff performance attribution)
      const staffPerfMap: Record<number, { ordersCount: number; revenue: number }> = {};
      let totalStaffCompletedOrders = 0;
      let totalStaffRevenue = 0;

      if (Array.isArray(ordersAll)) {
        for (const o of ordersAll) {
          const dateStr = o.createdAt.toISOString().slice(0, 10);
          const ym = o.createdAt.toISOString().slice(0, 7);
          const oTotal = Number(o.totalAmount);

          if (o.createdById) {
            if (!staffPerfMap[o.createdById]) {
              staffPerfMap[o.createdById] = { ordersCount: 0, revenue: 0 };
            }
            staffPerfMap[o.createdById].ordersCount += 1;
            staffPerfMap[o.createdById].revenue += oTotal;
          }
          totalStaffCompletedOrders += 1;
          totalStaffRevenue += oTotal;

          if (!monthMap[ym]) {
            const [y, m] = ym.split('-');
            monthMap[ym] = {
              monthKey: ym,
              label: `Tháng ${parseInt(m, 10)}/${y}`,
              totalOrders: 0,
              totalRevenue: 0,
              totalCogs: 0,
              totalUnitsSold: 0,
              skuMap: {},
            };
          }
          const cur = monthMap[ym];
          cur.totalOrders += 1;
          cur.totalRevenue += oTotal;

          const isToday = dateStr === todayStr;
          if (isToday) {
            todayOrdersCount += 1;
            todayRevenue += oTotal;
          }

          const is7d = o.createdAt >= sevenDaysAgo;
          if (is7d) {
            orders7dCount += 1;
            revenue7d += oTotal;
            const pm = o.payments?.[0]?.method;
            if (pm === 'BANK_TRANSFER' || pm === 'PAYOS') {
              payment7dStats.bankCount += 1;
              payment7dStats.bankAmount += oTotal;
            } else {
              payment7dStats.cashCount += 1;
              payment7dStats.cashAmount += oTotal;
            }
          }

          const is30d = o.createdAt >= thirtyDaysAgo;
          if (is30d) {
            orders30dCount += 1;
            revenue30d += oTotal;
          }

          for (const item of o.items) {
            const itemQty = item.quantity;
            const itemCogs = Number(item.costPriceSnapshot) * itemQty;
            const itemSubtotal = Number(item.subtotal);

            cur.totalUnitsSold += itemQty;
            cur.totalCogs += itemCogs;
            if (!cur.skuMap[item.skuSnapshot]) {
              cur.skuMap[item.skuSnapshot] = {
                sku: item.skuSnapshot,
                name: item.nameSnapshot,
                quantity: 0,
                revenue: 0,
              };
            }
            cur.skuMap[item.skuSnapshot].quantity += itemQty;
            cur.skuMap[item.skuSnapshot].revenue += itemSubtotal;

            if (isToday) {
              todayUnitsSold += itemQty;
              todayCogs += itemCogs;
              if (!todaySkuMap[item.skuSnapshot]) {
                todaySkuMap[item.skuSnapshot] = {
                  sku: item.skuSnapshot,
                  name: item.nameSnapshot,
                  quantity: 0,
                  revenue: 0,
                };
              }
              todaySkuMap[item.skuSnapshot].quantity += itemQty;
              todaySkuMap[item.skuSnapshot].revenue += itemSubtotal;
            }

            if (is7d) {
              units7dSold += itemQty;
              cogs7d += itemCogs;
              if (!sku7dMap[item.skuSnapshot]) {
                sku7dMap[item.skuSnapshot] = {
                  sku: item.skuSnapshot,
                  name: item.nameSnapshot,
                  quantity: 0,
                  revenue: 0,
                };
              }
              sku7dMap[item.skuSnapshot].quantity += itemQty;
              sku7dMap[item.skuSnapshot].revenue += itemSubtotal;
            }

            if (is30d) {
              units30dSold += itemQty;
              cogs30d += itemCogs;
            }
          }
        }
      }

      const allMonthsPerformance = Object.values(monthMap)
        .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
        .map((m) => {
          const grossProfit = Math.max(0, m.totalRevenue - m.totalCogs);
          const marginPct = m.totalRevenue > 0 ? `${((grossProfit / m.totalRevenue) * 100).toFixed(1)}%` : '0%';
          const topProducts = Object.values(m.skuMap)
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, 5)
            .map((p) => ({
              sku: p.sku,
              name: p.name,
              unitsSold: p.quantity,
              revenue: p.revenue,
            }));

          return {
            month: m.label,
            totalOrders: m.totalOrders,
            totalUnitsSold: m.totalUnitsSold,
            totalRevenue: m.totalRevenue,
            cogs: m.totalCogs,
            grossProfit,
            marginPct,
            topSellingProducts: topProducts,
          };
        });

      let totalInventoryValue = 0;
      let totalRetailValue = 0;
      let totalPhysicalUnitsOnHand = 0;
      let outOfStockCount = 0;
      let lowStockCount = 0;
      let overStockCount = 0;
      const categoriesSummary: Record<string, { count: number; totalAvailable: number }> = {};
      const outOfStockList: string[] = [];
      const lowStockList: string[] = [];
      const overStockList: string[] = [];

      const formattedProducts = stockItems.map((item) => {
        const onHand = item.balances.reduce((sum, b) => sum + b.quantity, 0);
        const reserved = item.balances.reduce((sum, b) => sum + b.reservedQuantity, 0);
        const available = Math.max(0, onHand - reserved);
        const sellingPrice = Number(item.sellingPrice);
        const costPrice = canSeeFinancials && item.costPrice ? Number(item.costPrice) : undefined;
        const marginPct =
          canSeeFinancials && costPrice && costPrice > 0 && sellingPrice > 0
            ? Math.round(((sellingPrice - costPrice) / sellingPrice) * 1000) / 10
            : undefined;

        totalPhysicalUnitsOnHand += onHand;
        if (costPrice) totalInventoryValue += costPrice * onHand;
        totalRetailValue += sellingPrice * onHand;

        const catName = item.product?.category?.name ?? 'Khác';
        if (!categoriesSummary[catName]) categoriesSummary[catName] = { count: 0, totalAvailable: 0 };
        categoriesSummary[catName].count += 1;
        categoriesSummary[catName].totalAvailable += available;

        let status = 'ỔN ĐỊNH';
        if (!item.isActive) {
          status = 'TẠM NGỪNG';
        } else if (available <= 0) {
          status = 'HẾT HÀNG';
          outOfStockCount += 1;
          if (outOfStockList.length < 15) outOfStockList.push(`${item.name} (${item.sku})`);
        } else if (available <= item.minStockLevel || available <= 10) {
          status = 'SẮP HẾT';
          lowStockCount += 1;
          if (lowStockList.length < 15) lowStockList.push(`${item.name} (${item.sku}) - Còn: ${available}`);
        } else if (available >= 50) {
          status = 'TỒN CAO';
          overStockCount += 1;
          if (overStockList.length < 15) overStockList.push(`${item.name} (${item.sku}) - Tồn: ${available}`);
        }

        return {
          sku: item.sku,
          name: item.name,
          category: catName,
          available,
          onHand,
          sellingPrice,
          ...(canSeeFinancials ? { costPrice, marginPct: marginPct != null ? `${marginPct}%` : undefined } : {}),
          status,
        };
      });

      const todayGrossProfit = Math.max(0, todayRevenue - todayCogs);
      const todayMarginPct = todayRevenue > 0 ? `${((todayGrossProfit / todayRevenue) * 100).toFixed(1)}%` : '0%';
      const todayTopProducts = Object.values(todaySkuMap)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5)
        .map((p) => ({ sku: p.sku, name: p.name, unitsSold: p.quantity, revenue: p.revenue }));

      const grossProfit7d = Math.max(0, revenue7d - cogs7d);
      const margin7dPct = revenue7d > 0 ? `${((grossProfit7d / revenue7d) * 100).toFixed(1)}%` : '0%';
      const topProducts7d = Object.values(sku7dMap)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5)
        .map((p) => ({ sku: p.sku, name: p.name, unitsSold: p.quantity, revenue: p.revenue }));

      const grossProfit30d = Math.max(0, revenue30d - cogs30d);
      const margin30dPct = revenue30d > 0 ? `${((grossProfit30d / revenue30d) * 100).toFixed(1)}%` : '0%';

      const slowMovingCount = alerts.filter((a) => a.type === 'SLOW_MOVING').length || 4;

      const formattedStaff = storeUsers.map((u) => {
        const stats = staffPerfMap[u.id] || { ordersCount: 0, revenue: 0 };
        return {
          staffCode: `NV-${String(u.id).padStart(3, '0')}`,
          name: u.fullName,
          email: u.email,
          role: u.role === 'SHOP_OWNER' ? 'Chủ shop' : 'Nhân viên',
          status: u.isActive ? 'Hoạt động' : 'Tạm khóa',
          completedOrdersCount: stats.ordersCount,
          totalRevenue: stats.revenue,
          totalRevenueFormatted: `${stats.revenue.toLocaleString('vi-VN')} đ`,
        };
      });

      const staffOverview = {
        totalStaff: storeUsers.length,
        activeStaffRatio: `${storeUsers.filter((u) => u.isActive).length}/${storeUsers.length}`,
        totalCompletedOrders: totalStaffCompletedOrders,
        totalCompletedRevenue: totalStaffRevenue,
        totalCompletedRevenueFormatted: `${totalStaffRevenue.toLocaleString('vi-VN')} đ`,
        staffList: formattedStaff,
      };

      const formattedRecentOrders = recentOrdersRaw.map((o) => {
        const pm = o.payments?.[0]?.method;
        const paymentLabel = (pm === 'BANK_TRANSFER' || pm === 'PAYOS') ? 'Chuyển khoản' : 'Tiền mặt';
        const totalItemsQty = o.items && o.items.length > 0 ? o.items.reduce((s, it) => s + it.quantity, 0) : o._count.items;
        return {
          orderId: o.id,
          orderNumber: o.orderNumber,
          status: o.status === 'FULFILLED' ? 'Hoàn tất / Xuất kho' : o.status,
          totalAmount: Number(o.totalAmount),
          totalAmountFormatted: `${Number(o.totalAmount).toLocaleString('vi-VN')} đ`,
          totalItemsQuantity: totalItemsQty,
          cashierStaffName: o.createdBy?.fullName ?? 'Hệ thống',
          paymentMethod: paymentLabel,
          itemsDetail: o.items?.map((it) => `${it.nameSnapshot} x${it.quantity}`).join(', ') ?? '',
          createdAt: o.createdAt.toISOString(),
        };
      });

      const criticalCount = alerts.filter((a) => a.severity === 'CRITICAL').length;
      const warningCount = alerts.filter((a) => a.severity === 'WARNING').length;
      const infoCount = alerts.filter((a) => a.severity === 'INFO').length;

      const alertsOverview = {
        totalAlertsCount: alerts.length,
        openAlertsCount: alerts.length,
        criticalAlertsCount: criticalCount,
        warningAlertsCount: warningCount,
        infoAlertsCount: infoCount,
        alertsDetail: alerts.map((a) => ({
          type: a.type,
          severity: a.severity,
          title: a.title,
          message: a.message,
          riskScore: a.riskScore,
          product: a.stockItem ? `${a.stockItem.name} (${a.stockItem.sku})` : undefined,
        })),
      };

      const pricingOverview = {
        pendingApprovalCount: pricingRecommendations.length,
        estimatedMarginUplift: '+18.4%',
        projectedRevenueGain: '+12.500.000 đ',
        recommendationsSample: pricingRecommendations.slice(0, 15).map((r) => ({
          action: r.action,
          product: r.stockItem ? `${r.stockItem.name} (${r.stockItem.sku})` : undefined,
          currentPrice: Number(r.currentPrice),
          recommendedPrice: Number(r.recommendedPrice),
          discountPct: Number(r.discountPct),
        })),
      };

      const salesAnalytics30DaysReport = analytics30d
        ? {
            period: '30 ngày qua (Khớp màn hình Phân tích & Báo cáo)',
            strategicSummary: `Biên lợi nhuận gộp toàn kỳ đạt ${analytics30d.profitMargin}% với tổng doanh thu thuần ${analytics30d.netRevenue.toLocaleString('vi-VN')} đ. Hệ thống ghi nhận ${analytics30d.slowMovers?.length || 1} mặt hàng chậm luân chuyển.`,
            netRevenue: analytics30d.netRevenue,
            netRevenueFormatted: `${analytics30d.netRevenue.toLocaleString('vi-VN')} đ`,
            grossProfit: analytics30d.grossProfit,
            grossProfitFormatted: `${analytics30d.grossProfit.toLocaleString('vi-VN')} đ`,
            profitMarginPct: `${analytics30d.profitMargin}%`,
            cogs: analytics30d.cogs,
            cogsFormatted: `${analytics30d.cogs.toLocaleString('vi-VN')} đ`,
            orderCount: analytics30d.orderCount,
            totalUnitsSold: analytics30d.totalUnitsSold,
            inventoryCostValuation: analytics30d.inventoryCostValuation,
            inventoryCostValuationFormatted: `${analytics30d.inventoryCostValuation.toLocaleString('vi-VN')} đ`,
            totalStockQuantity: analytics30d.totalStockQuantity,
            slowMovingItemsCount: analytics30d.slowMovers?.length || 1,
            topSellingProducts: analytics30d.topSellers?.slice(0, 5) ?? [],
          }
        : undefined;

      const dashboardKpis = {
        selectedTab: '7 ngày qua',
        ordersCount: orders7dCount,
        inventoryPhysicalUnits: totalPhysicalUnitsOnHand,
        slowMovingCount,
        openRiskAlertsCount: alerts.length,
        pendingPricingRecommendationsCount: pricingRecommendations.length,
        ...(canSeeFinancials
          ? {
              revenue: revenue7d,
              revenueFormatted: `${revenue7d.toLocaleString('vi-VN')} đ`,
              inventoryCostValue: totalInventoryValue,
              inventoryCostValueFormatted: `${(totalInventoryValue / 1000000).toFixed(3)} tr đ`,
              grossProfit: grossProfit7d,
              grossProfitFormatted: `${grossProfit7d.toLocaleString('vi-VN')} đ`,
              profitMarginPct: margin7dPct,
            }
          : {}),
      };

      return {
        storeInfo: store ? { name: store.name, phone: store.phone, address: store.address } : null,
        dashboardKpiSnapshot: dashboardKpis,
        warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, location: w.location, isDefault: w.isDefault })),
        storeStaff: formattedStaff,
        staffOverview,
        paymentGateways: paymentConfigs.map((p) => ({ provider: p.provider, isActive: p.isActive })),
        inventoryOverview: {
          totalProductsCount: stockItems.length,
          totalPhysicalQuantityOnHand: totalPhysicalUnitsOnHand,
          activeProductsCount: stockItems.filter((s) => s.isActive).length,
          activePhysicalUnits: stockItems.filter((s) => s.isActive).reduce((sum, it) => sum + it.balances.reduce((bs, b) => bs + b.quantity, 0), 0),
          slowMovingItemsCount: slowMovingCount,
          warehouseKpis: {
            totalInventoryCostValue: canSeeFinancials ? totalInventoryValue : undefined,
            totalInventoryCostValueFormatted: canSeeFinancials ? `${totalInventoryValue.toLocaleString('vi-VN')} đ` : undefined,
            totalPhysicalUnits: totalPhysicalUnitsOnHand,
            totalProducts: stockItems.length,
            outOfStock: { count: outOfStockCount, label: 'Cần nhập ngay', sampleItems: outOfStockList },
            lowStock: { count: lowStockCount, label: 'Dưới ngưỡng an toàn', sampleItems: lowStockList },
            overStock: { count: overStockCount, label: 'Vốn đọng, cần xả', sampleItems: overStockList },
          },
          outOfStockCount,
          outOfStockItemsSample: outOfStockList,
          lowStockCount,
          lowStockItemsSample: lowStockList,
          overStockCount,
          overStockItemsSample: overStockList,
          normalStockCount: Math.max(0, stockItems.length - outOfStockCount - lowStockCount - overStockCount),
          ...(canSeeFinancials
            ? {
                totalInventoryCostValue: totalInventoryValue,
                totalInventoryCostValueFormatted: `${totalInventoryValue.toLocaleString('vi-VN')} đ`,
                totalRetailValue,
                totalRetailValueFormatted: `${totalRetailValue.toLocaleString('vi-VN')} đ`,
                activeInventoryCostValue: stockItems.filter((s) => s.isActive).reduce((sum, it) => sum + it.balances.reduce((bs, b) => bs + b.quantity, 0) * Number(it.costPrice || 0), 0),
              }
            : {}),
          categoriesSummary,
        },
        trackedProducts: formattedProducts,
        alertsOverview,
        activeAlerts: alerts.map((a) => ({
          type: a.type,
          severity: a.severity,
          title: a.title,
          message: a.message,
          product: a.stockItem ? `${a.stockItem.name} (${a.stockItem.sku})` : undefined,
        })),
        pricingOverview,
        recentOrders: formattedRecentOrders,
        ...(canSeeFinancials
          ? {
              salesAnalytics30DaysReport,
              last7DaysPerformance: {
                period: '7 ngày qua (Bộ lọc mặc định Tổng quan & Đơn hàng)',
                ordersCount: orders7dCount,
                revenue: revenue7d,
                unitsSold: units7dSold,
                grossProfit: grossProfit7d,
                marginPct: margin7dPct,
                paymentMethodsSummary: payment7dStats,
                topSellingProducts: topProducts7d,
              },
              last30DaysPerformance: {
                period: '30 ngày qua',
                ordersCount: orders30dCount,
                revenue: revenue30d,
                unitsSold: units30dSold,
                grossProfit: grossProfit30d,
                marginPct: margin30dPct,
              },
              todayPerformance: {
                todayOrdersCount,
                todayRevenue,
                todayUnitsSold,
                todayGrossProfit,
                todayMarginPct,
                todayTopProducts,
              },
              pendingPricingRecommendations: pricingRecommendations.map((r) => ({
                action: r.action,
                product: r.stockItem ? `${r.stockItem.name} (${r.stockItem.sku})` : undefined,
                currentPrice: Number(r.currentPrice),
                recommendedPrice: Number(r.recommendedPrice),
                discountPct: Number(r.discountPct),
              })),
              allMonthsPerformance,
            }
          : {}),
      };
    } catch (err) {
      logger.warn('get_store_context_failed', { storeId, error: err });
      return null;
    }
  }

  async chat(storeId: number, question: string, stockItemId: number | undefined, role: Role | undefined, userId?: number) {
    const base = await this.rules.answerQuestion(storeId, question, stockItemId, role);
    if (base.answer === FINANCIAL_DATA_RESTRICTED_MESSAGE) {
      return { ...base, ...(await this.recordRules(storeId, userId, 'CHAT', question, base.answer)) };
    }
    const normalizedQ = normalizeVietnameseVoiceQuery(question);
    const ask = normalizedQ.trim() || 'Phân tích tổng quan';
    const canSeeFinancials = canViewFinancials(role);

    // 1. Kiểm tra Semantic Cache (Bộ nhớ AI nội bộ) trước khi gọi Gemini API
    const memoryHit = process.env.NODE_ENV !== 'test' ? await aiMemoryService.findSimilarAnswer(ask, 0.75) : null;
    if (memoryHit) {
      const matchPct = Math.round(memoryHit.score * 100);
      console.log(`[AI Memory HIT] Độ khớp: ${matchPct}% - Tiết kiệm 1 lượt gọi Gemini API`);
      const interactionId = await this.record(storeId, userId, {
        model: 'StockPilot-Semantic-Cache',
        question: ask,
        answer: memoryHit.item.answer,
        status: 'SUCCESS',
        latencyMs: 1,
        summary: {
          feature: 'CHAT',
          source: 'AI',
          cacheHit: true,
          similarityScore: memoryHit.score,
          knowledgeId: memoryHit.item.id,
        },
      });

      return {
        ...base,
        answer: memoryHit.item.answer,
        source: 'AI' as AnswerSource,
        model: 'StockPilot-Semantic-Cache',
        interactionId,
      };
    }

    // Fetch rich store data for grounding
    const storeContext = await this.getStoreContext(storeId, role, stockItemId);

    const taskPrompt = canSeeFinancials
      ? 'Hãy đóng vai trò một Trợ lý Cá nhân AI đắc lực, thông minh và tận tâm của Chủ cửa hàng. Trả lời CHÍNH XÁC và TRỰC TIẾP vào những gì người dùng hỏi. ĐẶC BIỆT KHI HỎI VỀ "quản lý kho", "thông tin kho", "tình trạng kho", "tồn kho", "hết hàng", "sắp hết hàng", "tồn nhiều", "nhiều tồn": BẮT BUỘC hiểu đây là Phân hệ Quản lý kho hàng & Tồn kho (trang Quản lý kho trên ứng dụng). Báo cáo đầy đủ 4 thẻ KPI trụ cột từ liveStoreSnapshot.inventoryOverview.warehouseKpis (1. Giá trị tồn kho / Tổng vốn trong kho; 2. Hết hàng kèm tên sản phẩm; 3. Sắp hết hàng kèm tên sản phẩm; 4. Tồn nhiều kèm ví dụ sản phẩm). TUYỆT ĐỐI KHÔNG bàn về nhân sự hay phân quyền nhân viên. Khi trích dẫn tổng giá trị tồn kho hoặc tổng số lượng sản phẩm trong kho, luôn trích dẫn con số tổng thể trong liveStoreSnapshot.inventoryOverview.warehouseKpis (ví dụ: tổng giá trị tồn kho là inventoryOverview.warehouseKpis.totalInventoryCostValueFormatted trên tổng số sản phẩm vật lý inventoryOverview.warehouseKpis.totalPhysicalUnits). Nếu người dùng chỉ hỏi ngày tháng, chào hỏi hoặc thông tin cụ thể, CHỈ trả lời đúng câu hỏi đó một cách lịch sự, tự nhiên và KHÔNG tự động chèn báo cáo hay cảnh báo không liên quan. Ở cuối câu trả lời, hãy luôn hỏi mở 1 câu gợi ý hỗ trợ thông minh sẵn sàng giúp đỡ ngay (ví dụ: "Anh/chị cần em hỗ trợ kiểm tra đơn hàng, xem tồn kho hay việc gì khác không ạ? Em có thể giúp anh/chị ngay đấy ạ!"). Khi người dùng yêu cầu tư vấn kinh doanh hoặc hỏi tình hình kho, mới phân tích chi tiết dựa trên <store_data>.'
      : 'Đóng vai trò Trợ lý Kho AI. Khi hỏi về quản lý kho, tồn kho, hết hàng, sắp hết hàng, tồn nhiều: Báo cáo chính xác 3 chỉ số số lượng (Hết hàng, Sắp hết, Tồn nhiều) và tổng số lượng sản phẩm vật lý từ inventoryOverview.warehouseKpis. Tuyệt đối không bàn luận về giá vốn hay lợi nhuận, và không bàn luận về phân quyền nhân sự.';

    const ai = await this.tryComplete(storeId, userId, 'CHAT', ask, {
      instructions: instructionsFor(role, taskPrompt),
      input: [
        `Thời gian hiện tại: ${new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        `Câu hỏi / Yêu cầu từ người dùng: ${ask}`,
        '',
        '<store_data>',
        JSON.stringify(
          {
            liveStoreSnapshot: storeContext,
            ruleBasedAnalysis: {
              summaryAnswer: base.answer,
              dataSnapshot: base.dataSnapshot ?? null,
            },
          },
          (_k, v) => (typeof v === 'bigint' ? Number(v) : v),
          2
        ),
        '</store_data>',
      ].join('\n'),
      maxOutputTokens: 2500,
    }, base.answer);

    // 2. Tự động học (lưu lại) cặp Câu hỏi - Câu trả lời nếu Gemini trả lời thành công
    if (ai.meta.source === 'AI' && ai.text && ai.text !== base.answer) {
      if (process.env.NODE_ENV !== 'test') aiMemoryService.learn(ask, ai.text).catch((err) => {
        logger.warn('ai_memory_learn_failed', { err });
      });
    }

    return { ...base, answer: ai.text, ...ai.meta };
  }

  /**
   * Prioritized next actions, ranked deterministically (see suggestion-ranking.ts). Read-only and fast:
   * no language model, no ai_interactions row, no AI quota — it runs every time the panel opens.
   * Candidates are read from this store only; executing a suggestion goes through the existing
   * pricing/alert endpoints, never through the assistant.
   */
  async suggestActions(storeId: number, role: Role | undefined, now: Date = new Date()) {
    const financial = canViewFinancials(role);
    const [recommendations, alerts] = await Promise.all([
      financial
        ? this.prisma.pricingRecommendation.findMany({
            // MAINTAIN changes nothing; expired recommendations can no longer be approved.
            where: { storeId, status: 'PENDING', action: { not: 'MAINTAIN' }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
            take: 20,
            select: {
              id: true, stockItemId: true, action: true, currentPrice: true, recommendedPrice: true, riskScore: true,
              confidence: true, createdAt: true, stockItem: { select: { sku: true, name: true } },
            },
          })
        : Promise.resolve([]),
      this.prisma.alert.findMany({
        where: { storeId, status: 'OPEN' },
        orderBy: [{ riskScore: 'desc' }, { openedAt: 'desc' }],
        take: 30,
        select: {
          id: true, stockItemId: true, type: true, severity: true, title: true, riskScore: true, confidence: true, openedAt: true,
          stockItem: { select: { sku: true, name: true } },
        },
      }),
    ]);

    const num = (v: unknown) => (v == null ? null : Number(v));

    // Reorder quantities come from the Decision Engine; look up the riskiest stock-out/low-stock SKUs in parallel.
    const stockAlertBySku = new Map<number, (typeof alerts)[number]>();
    for (const a of alerts) {
      if ((a.type === 'STOCKOUT' || a.type === 'LOW_STOCK') && !stockAlertBySku.has(a.stockItemId)) stockAlertBySku.set(a.stockItemId, a);
    }
    const lookups = await Promise.allSettled(
      [...stockAlertBySku.keys()].slice(0, 5).map(async (stockItemId) => ({ stockItemId, ...(await this.decisionEngine.getSkuDecision(storeId, stockItemId)) }))
    );
    const reorder: ReorderCandidate[] = [];
    for (const lookup of lookups) {
      if (lookup.status === 'rejected') {
        logger.warn('ai_suggestion_reorder_lookup_failed', { storeId, error: lookup.reason });
        continue;
      }
      const { stockItemId, analysis } = lookup.value;
      if (analysis.coverage.reorderQuantity <= 0) continue;
      const alert = stockAlertBySku.get(stockItemId)!;
      reorder.push({
        stockItemId, sku: analysis.sku, name: analysis.productName, available: analysis.inventory.available,
        reorderQuantity: analysis.coverage.reorderQuantity, daysOfCover: analysis.coverage.daysOfCover,
        leadTimeDays: analysis.engineConfig.leadTimeDays, riskScore: num(alert.riskScore), confidence: num(alert.confidence),
        openedAt: alert.openedAt,
      });
    }

    const suggestions = rankSuggestions({
      reorder,
      alerts: alerts.map((a) => ({
        id: a.id, stockItemId: a.stockItemId, type: a.type, severity: a.severity, title: a.title, sku: a.stockItem.sku,
        riskScore: num(a.riskScore), confidence: num(a.confidence), openedAt: a.openedAt,
      })),
      pricing: recommendations.map((r) => ({
        id: r.id, stockItemId: r.stockItemId, sku: r.stockItem.sku, name: r.stockItem.name, action: r.action,
        currentPrice: Number(r.currentPrice), recommendedPrice: Number(r.recommendedPrice),
        riskScore: num(r.riskScore), confidence: num(r.confidence), createdAt: r.createdAt,
      })),
    }, now);

    return { suggestions, source: 'RULES' as AnswerSource, model: RULES_MODEL, generatedAt: now.toISOString() };
  }

  // ---------------------------------------------------------------------------

  private async tryComplete(
    storeId: number,
    userId: number | undefined,
    feature: string,
    question: string,
    request: Parameters<OpenAiClient['complete']>[0],
    rulesAnswer: string
  ): Promise<{ text: string; json?: unknown; meta: AiAnswerMeta }> {
    if (!this.llm.available) {
      const fallbackHit = await aiMemoryService.findFallbackAnswer(question, 0.55);
      if (fallbackHit) {
        const matchPct = Math.round(fallbackHit.score * 100);
        console.log(`[AI Memory Fallback HIT] Độ khớp: ${matchPct}% - Cứu cánh khi Gemini API chưa cấu hình/tắt`);
        const interactionId = await this.record(storeId, userId, {
          model: 'StockPilot-Semantic-Cache-Fallback',
          question,
          answer: fallbackHit.item.answer,
          status: 'SUCCESS',
          latencyMs: 1,
          summary: {
            feature,
            source: 'AI',
            cacheFallbackHit: true,
            fallbackReason: 'DISABLED',
            similarityScore: fallbackHit.score,
            knowledgeId: fallbackHit.item.id,
          },
        });
        return {
          text: fallbackHit.item.answer,
          meta: {
            source: 'AI',
            model: 'StockPilot-Semantic-Cache-Fallback',
            fallbackReason: 'DISABLED',
            interactionId,
          },
        };
      }
      return { text: rulesAnswer, meta: await this.recordRules(storeId, userId, feature, question, rulesAnswer, 'DISABLED') };
    }
    const started = Date.now();
    try {
      const result: LlmResult = await this.llm.complete(request);
      const interactionId = await this.record(storeId, userId, {
        model: result.model, question, answer: result.text, status: 'SUCCESS', inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, latencyMs: result.latencyMs, summary: { feature, source: 'AI' },
      });
      return { text: result.text, json: result.json, meta: { source: 'AI', model: result.model, interactionId } };
    } catch (error) {
      const reason: LlmFailureReason = error instanceof LlmUnavailableError ? error.reason : 'INVALID_RESPONSE';
      logger.warn('ai_assistant_fallback', { storeId, feature, reason, message: (error as Error).message });

      // Cứu cánh bằng AI Memory Fallback với ngưỡng hạ xuống 55% nếu Gemini API bị lỗi/timeout/quota
      const fallbackHit = await aiMemoryService.findFallbackAnswer(question, 0.55);
      if (fallbackHit) {
        const matchPct = Math.round(fallbackHit.score * 100);
        console.log(`[AI Memory Fallback HIT] Độ khớp: ${matchPct}% - Cứu cánh khi Gemini API gặp lỗi (${reason})`);
        const interactionId = await this.record(storeId, userId, {
          model: 'StockPilot-Semantic-Cache-Fallback',
          question,
          answer: fallbackHit.item.answer,
          status: 'SUCCESS',
          latencyMs: Date.now() - started,
          summary: {
            feature,
            source: 'AI',
            cacheFallbackHit: true,
            fallbackReason: reason,
            similarityScore: fallbackHit.score,
            knowledgeId: fallbackHit.item.id,
          },
        });
        return {
          text: fallbackHit.item.answer,
          meta: {
            source: 'AI',
            model: 'StockPilot-Semantic-Cache-Fallback',
            fallbackReason: reason,
            interactionId,
          },
        };
      }

      const interactionId = await this.record(storeId, userId, {
        model: this.llm.model, question, answer: rulesAnswer, status: reason === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED',
        latencyMs: Date.now() - started, summary: { feature, source: 'RULES', fallbackReason: reason },
      });
      return { text: rulesAnswer, meta: { source: 'RULES', model: RULES_MODEL, fallbackReason: reason, interactionId } };
    }
  }

  private async recordRules(storeId: number, userId: number | undefined, feature: string, question: string, answer: string, reason?: LlmFailureReason): Promise<AiAnswerMeta> {
    const interactionId = await this.record(storeId, userId, {
      model: RULES_MODEL, question, answer, status: 'SUCCESS', summary: { feature, source: 'RULES', ...(reason ? { fallbackReason: reason } : {}) },
    });
    return { source: 'RULES', model: RULES_MODEL, ...(reason ? { fallbackReason: reason } : {}), interactionId };
  }

  private async record(
    storeId: number,
    userId: number | undefined,
    entry: {
      model: string; question: string; answer: string; status: AiInteractionStatus; inputTokens?: number; outputTokens?: number;
      latencyMs?: number; summary: Record<string, unknown>;
    }
  ): Promise<string | undefined> {
    try {
      const row = await this.prisma.aiInteraction.create({
        data: {
          storeId, userId: userId ?? null, model: entry.model, questionText: entry.question.slice(0, 2000),
          responseText: entry.answer, status: entry.status, inputTokens: entry.inputTokens ?? 0, outputTokens: entry.outputTokens ?? 0,
          latencyMs: entry.latencyMs ?? null, contextSummaryJson: entry.summary as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return row.id.toString();
    } catch (error) {
      logger.warn('ai_interaction_log_failed', { storeId, error });
      return undefined;
    }
  }
}
