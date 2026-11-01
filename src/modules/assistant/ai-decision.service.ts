import { AiInteractionStatus, Prisma, PrismaClient, Role } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../../common/logger';
import { canViewFinancials } from '../../common/utils/role-access';
import { DecisionEngineService } from '../decision-engine/decision-engine.service';
import { AssistantService, FINANCIAL_DATA_RESTRICTED_MESSAGE } from './assistant.service';
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
  'Bạn là AI Pilot — Trợ lý AI Cố vấn Kinh doanh & Quản trị Cửa hàng của StockPilot tại Việt Nam.',
  'NGUYÊN TẮC HOẠT ĐỘNG:',
  '1. HỖ TRỢ TOÀN DIỆN & KHÔNG GIỚI HẠN:',
  '   - Luôn sẵn sàng đáp ứng mọi câu hỏi và yêu cầu từ người dùng (chủ cửa hàng): từ phân tích số liệu kinh doanh, quản trị kho hàng, tối ưu giá bán, lên kế hoạch xả hàng đọng, đến tư vấn marketing, viết kịch bản bán hàng/livestream/chăm sóc khách hàng, ý tưởng phát triển doanh thu cửa hàng.',
  '   - Tuyệt đối không từ chối cứng nhắc hoặc nói rằng "tôi chỉ trả lời dữ kiện có sẵn". Với các câu hỏi mở, tư vấn chiến lược, kịch bản hoặc kế hoạch, hãy thoải mái sáng tạo giải pháp thực chiến nhất cho mô hình bán lẻ tại Việt Nam.',
  '2. BÁM SÁT SỐ LIỆU THỰC TẾ CỦA CỬA HÀNG:',
  '   - Khối <store_data> chứa toàn bộ dữ liệu thực tế về sản phẩm, giá bán, tồn kho, cảnh báo rủi ro và các đề xuất của cửa hàng.',
  '   - Khi đưa ra ví dụ, phân tích hoặc lập kế hoạch, hãy LUÔN ƯU TIÊN gọi tên chính xác các mặt hàng, mã SKU, số lượng tồn kho và mức giá thực tế của cửa hàng từ <store_data>.',
  '   - Không bịa đặt số liệu sai lệch về số lượng tồn kho hay tiền bạc của cửa hàng.',
  '3. TRỰC DIỆN, ĐÚNG TRỌNG TÂM, KHÔNG LAN MAN:',
  '   - Đi thẳng vào câu trả lời, phân tích sắc bén, cô đọng, không nói vòng vo lý thuyết sáo rỗng.',
  '   - Trình bày trực quan bằng Markdown: gạch đầu dòng rõ ràng, bảng biểu số liệu (nếu cần), in đậm điểm nhấn quan trọng.',
  '   - Kèm theo các bước hành động cụ thể (Actionable Steps) để người dùng có thể áp dụng ngay trong thực tế.',
  '   - Tiền tệ định dạng chuẩn Việt Nam (ví dụ: 25.000 đ, 150.000 đ).',
  '   - Mọi thay đổi về giá hoặc tồn kho do người dùng tự thao tác duyệt trên phần mềm; bạn đóng vai trò cố vấn thông minh đưa ra giải pháp tốt nhất.',
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
    private readonly decisionEngine: DecisionEngineService = new DecisionEngineService(prisma)
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
      const [store, stockItems, alerts, pricingRecommendations, orders30d] = await Promise.all([
        this.prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true, phone: true, address: true },
        }),
        this.prisma.stockItem.findMany({
          where: { storeId, isActive: true },
          select: {
            id: true,
            sku: true,
            name: true,
            sellingPrice: true,
            ...(canSeeFinancials ? { costPrice: true } : {}),
            minStockLevel: true,
            maxStockLevel: true,
            product: { select: { category: { select: { name: true } } } },
            balances: { select: { quantity: true, reservedQuantity: true } },
          },
          take: 50,
          orderBy: { updatedAt: 'desc' },
        }),
        this.prisma.alert.findMany({
          where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          select: {
            type: true,
            severity: true,
            title: true,
            message: true,
            stockItem: { select: { sku: true, name: true } },
          },
          take: 10,
          orderBy: [{ riskScore: 'desc' }, { openedAt: 'desc' }],
        }),
        canSeeFinancials
          ? this.prisma.pricingRecommendation.findMany({
              where: { storeId, status: 'PENDING' },
              select: {
                action: true,
                currentPrice: true,
                recommendedPrice: true,
                discountPct: true,
                stockItem: { select: { sku: true, name: true } },
              },
              take: 10,
              orderBy: { riskScore: 'desc' },
            })
          : Promise.resolve([]),
        canSeeFinancials
          ? this.prisma.order.findMany({
              where: {
                storeId,
                status: { in: ['FULFILLED', 'CONFIRMED'] },
                createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
              },
              select: { totalAmount: true },
            })
          : Promise.resolve([]),
      ]);

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

        return {
          sku: item.sku,
          name: item.name,
          category: item.product?.category?.name ?? 'Khác',
          available,
          onHand,
          sellingPrice,
          ...(canSeeFinancials ? { costPrice, marginPct: marginPct != null ? `${marginPct}%` : undefined } : {}),
          status:
            available <= 0
              ? 'HẾT HÀNG'
              : available <= item.minStockLevel
              ? 'SẮP HẾT'
              : available >= item.maxStockLevel
              ? 'TỒN CAO'
              : 'ỔN ĐỊNH',
        };
      });

      const revenue30d = orders30d.reduce((sum, o) => sum + Number(o.totalAmount), 0);

      return {
        storeInfo: store ? { name: store.name, address: store.address } : null,
        trackedProducts: formattedProducts,
        activeAlerts: alerts.map((a) => ({
          severity: a.severity,
          title: a.title,
          product: a.stockItem ? `${a.stockItem.name} (${a.stockItem.sku})` : undefined,
        })),
        ...(canSeeFinancials
          ? {
              pendingPricingRecommendations: pricingRecommendations.map((r) => ({
                action: r.action,
                product: r.stockItem ? `${r.stockItem.name} (${r.stockItem.sku})` : undefined,
                currentPrice: Number(r.currentPrice),
                recommendedPrice: Number(r.recommendedPrice),
              })),
              monthlyPerformance: {
                completedOrdersLast30d: orders30d.length,
                totalRevenueLast30d: revenue30d,
              },
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
    const ask = question.trim() || 'Phân tích tổng quan';
    const canSeeFinancials = canViewFinancials(role);

    // Fetch rich store data for grounding
    const storeContext = await this.getStoreContext(storeId, role, stockItemId);

    const taskPrompt = canSeeFinancials
      ? 'Hãy trả lời câu hỏi hoặc thực hiện yêu cầu của Chủ cửa hàng một cách thông minh, sắc bén và không giới hạn. Tận dụng toàn bộ số liệu thực tế của cửa hàng trong <store_data> để phân tích chính xác, không lan man, nêu bật các số liệu thực tế (tên sản phẩm, giá bán, tồn kho, cảnh báo). Đưa ra các giải pháp hành động cụ thể (Action Steps) có thể làm ngay.'
      : 'Trả lời câu hỏi của Nhân viên kho dựa trên dữ liệu cửa hàng trong <store_data>. Trực diện, rõ ràng, tập trung vào số lượng, kiểm kho và vận hành kho. Tuyệt đối không bàn luận về giá vốn hay lợi nhuận.';

    const ai = await this.tryComplete(storeId, userId, 'CHAT', ask, {
      instructions: instructionsFor(role, taskPrompt),
      input: [
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
