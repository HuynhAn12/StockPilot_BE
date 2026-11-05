import { Request, Response, NextFunction } from 'express';
import { AiDecisionService } from './ai-decision.service';
import { explainSkuQuerySchema } from './assistant.schema';
import { FINANCIAL_DATA_RESTRICTED_MESSAGE } from './assistant.service';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { logger } from '../../common/logger';
import { RateLimitedError } from '../../common/errors/app-error';
import { SystemSettingsService } from '../../common/services/system-settings.service';
import { businessDateRangeToUtc, toBusinessDateKey } from '../../common/utils/business-date';

/** Enforces the admin-configured daily AI quota per store (0 = unlimited). */
export async function assertAiQuota(storeId: number) {
  const quota = await SystemSettingsService.get('ai.dailyQuotaPerStore');
  if (!quota) return;

  const { startUtc, endUtc } = businessDateRangeToUtc(toBusinessDateKey(new Date()));
  const usedToday = await prisma.aiInteraction.count({
    where: { storeId, createdAt: { gte: startUtc, lt: endUtc } },
  });
  if (usedToday >= quota) {
    throw new RateLimitedError(
      `Cửa hàng đã dùng hết ${quota} lượt hỏi trợ lý AI hôm nay. Hạn mức sẽ được làm mới vào 0 giờ.`,
      { quota, usedToday }
    );
  }
}

export class AssistantController {
  constructor(private readonly service: AiDecisionService = new AiDecisionService()) {}

  explainSku = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      await assertAiQuota(storeId);
      const query = explainSkuQuerySchema.parse({
        stockItemId: req.params.stockItemId,
        question: req.query.question,
      });

      const result = await this.service.explainSku(storeId, query.stockItemId, query.question, req.user!.role, req.user?.userId);

      // Defense in depth: staff context never contains financial fields, so neither the rule text nor the
      // model can mention them; these scrubs only guard the rule-based template wording.
      if (req.user?.role === 'WAREHOUSE_STAFF') {
        result.explanation = result.explanation
          .replace(/ \| \*\*Giá vốn:\*\* [^|]+ \| \*\*Biên lợi nhuận:\*\* \*\*[^*]+\*\*/g, '')
          .replace(/\*\*Giá vốn:\*\* [^|\n]+/g, '**Giá vốn:** [Đã ẩn]')
          .replace(/\*\*Biên lợi nhuận:\*\* [^|\n]+/g, '**Biên lợi nhuận:** [Đã ẩn]');
        if (result.factualContext?.product) {
          result.factualContext.product.costPrice = null as any;
        }
        if (result.factualContext?.pricingRecommendation) {
          result.factualContext.pricingRecommendation = null;
        }
      }

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  explainStoreOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      await assertAiQuota(storeId);

      const result = await this.service.explainOverview(storeId, req.user!.role, req.user?.userId);

      // Defense in depth for the rule-based wording; metrics are already projected per role.
      if (req.user?.role === 'WAREHOUSE_STAFF') {
        result.summary = result.summary
          .replace(/\(Vốn đọng: \*\*[^*]+\*\*\)/g, '')
          .replace(/tab "Gợi ý giá bán" để duyệt các mức giá mới tối ưu lợi nhuận/g, 'tab "Cảnh báo rủi ro" để kiểm đếm');
        result.pendingRecommendationsCount = 0;
      }

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  chat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const { question, stockItemId } = req.body;
      const q = (question || '').trim();

      if (req.user?.role === 'WAREHOUSE_STAFF') {
        const financialKeywords = [
          'doanh thu', 'lãi', 'lợi nhuận', 'giá vốn', 'tiền vốn', 'vốn đọng',
          'revenue', 'profit', 'cost price', 'margin', 'cogs', 'tổng vốn',
        ];
        if (financialKeywords.some((kw) => q.toLowerCase().includes(kw))) {
          return res.status(200).json({
            success: true,
            data: {
              id: 'staff-guard',
              answer: FINANCIAL_DATA_RESTRICTED_MESSAGE,
              actionLinks: [],
              meta: null,
              source: 'RULES',
              createdAt: new Date().toISOString(),
            },
          });
        }
      }

      await assertAiQuota(storeId);
      const result = await this.service.chat(storeId, q, stockItemId ? Number(stockItemId) : undefined, req.user!.role, req.user?.userId);

      return res.status(200).json({
        success: true,
        data: {
          id: result.interactionId ?? `local-${Date.now()}`,
          answer: result.answer,
          actionLinks: result.actionLinks || [],
          meta: result.dataSnapshot || null,
          source: result.source,
          model: result.model,
          fallbackReason: result.fallbackReason ?? null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  suggestions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Không gọi AI và không ghi ai_interactions nên không tính vào hạn mức AI hằng ngày.
      const result = await this.service.suggestActions(req.user!.storeId!, req.user!.role);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /**
   * A user's own chat history only: owner answers can contain cost and profit figures.
   * SKU explanations, overviews and suggestion runs are logged too but are not chat turns.
   */
  getHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

      const interactions = await prisma.aiInteraction.findMany({
        where: { storeId, userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        take: limit * 4,
        select: { id: true, model: true, questionText: true, responseText: true, status: true, contextSummaryJson: true, createdAt: true },
      });

      const chatTurns = interactions
        .filter((item) => {
          const feature = (item.contextSummaryJson as { feature?: string } | null)?.feature;
          return !feature || feature === 'CHAT';
        })
        .slice(0, limit)
        .map(({ contextSummaryJson, ...item }) => ({
          ...item,
          id: item.id.toString(),
          source: (contextSummaryJson as { source?: string } | null)?.source === 'AI' ? 'AI' : 'RULES',
        }));

      return res.status(200).json({ success: true, data: chatTurns });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Transcribes voice audio into Vietnamese text using Groq Whisper API (whisper-large-v3).
   */
  transcribe = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!env.GROQ_API_KEY) {
        return res.status(503).json({ success: false, error: { message: 'GROQ_API_KEY chưa được cấu hình.' } });
      }

      let audioBuffer: Buffer | undefined;
      let mimeType = 'audio/webm';
      let fileName = 'audio.webm';

      if (req.file) {
        audioBuffer = req.file.buffer;
        mimeType = req.file.mimetype || 'audio/webm';
        fileName = req.file.originalname || 'audio.webm';
      } else if (req.body?.audioBase64) {
        audioBuffer = Buffer.from(req.body.audioBase64, 'base64');
        if (req.body.mimeType) mimeType = req.body.mimeType;
        if (req.body.fileName) fileName = req.body.fileName;
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({ success: false, error: { message: 'Không tìm thấy dữ liệu âm thanh.' } });
      }

      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      formData.append('file', blob, fileName);
      formData.append('model', env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
      formData.append('language', 'vi');
      formData.append('response_format', 'json');
      formData.append('prompt', 'StockPilot, KiotViet, Sapo, POS, quản lý bán hàng, tồn kho, doanh thu, lợi nhuận, giá vốn, hóa đơn, khách hàng, nhà cung cấp, sản phẩm, chiết khấu.');

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        logger.error('groq_transcribe_error', { status: response.status, errorData });
        return res.status(response.status).json({
          success: false,
          error: { message: 'Lỗi khi nhận diện giọng nói từ Groq Whisper' },
        });
      }

      const data = (await response.json()) as { text?: string };
      let transcribedText = (data.text || '').trim();
      transcribedText = transcribedText
        .replace(/\b(cây\s*ốc\s*việt|k\s*kiốt\s*việt|ki\s*ốt\s*việt|k\s*kiot\s*viet|kiot\s*viet)\b/gi, 'KiotViet')
        .replace(/\b(stock\s*pilot|s\s*tốc\s*pai\s*lợt|tốc\s*pai\s*lợt)\b/gi, 'StockPilot')
        .replace(/\b(ai\s*pilot|ây\s*ai\s*pai\s*lợt)\b/gi, 'AI Pilot')
        .replace(/\b(sa\s*po)\b/gi, 'Sapo')
        .replace(/\b(pi\s*âu\s*ét|bê\s*ô\s*ét)\b/gi, 'POS');

      return res.status(200).json({
        success: true,
        data: { text: transcribedText },
      });
    } catch (error) {
      next(error);
    }
  };
}
