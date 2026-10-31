import { Request, Response, NextFunction } from 'express';
import { AiDecisionService } from './ai-decision.service';
import { explainSkuQuerySchema } from './assistant.schema';
import { FINANCIAL_DATA_RESTRICTED_MESSAGE } from './assistant.service';
import { prisma } from '../../config/db';
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
      const storeId = req.user!.storeId!;
      await assertAiQuota(storeId);
      const result = await this.service.suggestActions(storeId, req.user!.role, req.user?.userId);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /** A user's own assistant history only: owner answers can contain cost and profit figures. */
  getHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

      const interactions = await prisma.aiInteraction.findMany({
        where: { storeId, userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, model: true, questionText: true, responseText: true, status: true, createdAt: true },
      });

      return res.status(200).json({
        success: true,
        data: interactions.map((item) => ({ ...item, id: item.id.toString() })),
      });
    } catch (error) {
      next(error);
    }
  };
}
