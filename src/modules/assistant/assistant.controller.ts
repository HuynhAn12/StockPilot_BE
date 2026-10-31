import { Request, Response, NextFunction } from 'express';
import { AssistantService } from './assistant.service';
import { explainSkuQuerySchema } from './assistant.schema';
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
  constructor(private readonly service: AssistantService = new AssistantService()) {}

  explainSku = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      await assertAiQuota(storeId);
      const query = explainSkuQuerySchema.parse({
        stockItemId: req.params.stockItemId,
        question: req.query.question,
      });

      const result = await this.service.explainSku(storeId, query.stockItemId, query.question, req.user!.role);

      // Defense in depth: the service already builds staff text without financial content.
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

      // Log interaction
      await prisma.aiInteraction.create({
        data: {
          storeId,
          userId: req.user?.userId ?? null,
          model: 'StockPilot-DecisionEngine-v2',
          questionText: query.question || `Giải thích SP ${query.stockItemId}`,
          responseText: result.explanation,
          status: 'SUCCESS',
        },
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  explainStoreOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      await assertAiQuota(storeId);

      const result = await this.service.explainStoreOverview(storeId, req.user!.role);

      // Defense in depth: the service already omits capital values and pending pricing counts
      // (metrics are projected by toOverviewSummaryView) for staff.
      if (req.user?.role === 'WAREHOUSE_STAFF') {
        result.summary = result.summary
          .replace(/\(Vốn đọng: \*\*[^*]+\*\*\)/g, '')
          .replace(/tab "Gợi ý giá bán" để duyệt các mức giá mới tối ưu lợi nhuận/g, 'tab "Cảnh báo rủi ro" để kiểm đếm');
        result.pendingRecommendationsCount = 0;
      }

      // Log interaction
      await prisma.aiInteraction.create({
        data: {
          storeId,
          userId: req.user?.userId ?? null,
          model: 'StockPilot-DecisionEngine-v2',
          questionText: 'Tổng quan kho hàng hôm nay',
          responseText: result.summary,
          status: 'SUCCESS',
        },
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        data: result,
      });
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
        const isFinancialQuery = financialKeywords.some((kw) => q.toLowerCase().includes(kw));
        if (isFinancialQuery) {
          const staffRefusalMsg =
            'Xin lỗi, tài khoản Nhân viên chỉ được phép tra cứu số lượng tồn kho và nghiệp vụ vận hành. Vui lòng liên hệ Chủ cửa hàng để xem dữ liệu tài chính.';
          return res.status(200).json({
            success: true,
            data: {
              id: 'staff-guard',
              answer: staffRefusalMsg,
              actionLinks: [],
              meta: null,
              createdAt: new Date().toISOString(),
            },
          });
        }
      }

      await assertAiQuota(storeId);
      const result = await this.service.answerQuestion(
        storeId,
        q,
        stockItemId ? Number(stockItemId) : undefined,
        req.user!.role
      );

      const interaction = await prisma.aiInteraction.create({
        data: {
          storeId,
          userId: req.user?.userId ?? null,
          model: 'StockPilot-AIPilot-v2',
          questionText: q || 'Phân tích tổng quan',
          responseText: result.answer,
          status: 'SUCCESS',
        },
      });

      return res.status(200).json({
        success: true,
        data: {
          id: interaction.id.toString(),
          answer: result.answer,
          actionLinks: result.actionLinks || [],
          meta: result.dataSnapshot || null,
          createdAt: interaction.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

      const interactions = await prisma.aiInteraction.findMany({
        where: { storeId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      const serialized = interactions.map((item) => ({
        ...item,
        id: item.id.toString(),
      }));

      return res.status(200).json({
        success: true,
        data: serialized,
      });
    } catch (error) {
      next(error);
    }
  };
}
