import { AiDecisionService, rankSuggestionsByRules } from '../../src/modules/assistant/ai-decision.service';
import { FINANCIAL_DATA_RESTRICTED_MESSAGE } from '../../src/modules/assistant/assistant.service';
import { LlmUnavailableError } from '../../src/modules/assistant/llm/openai-client';

function makePrisma() {
  return {
    aiInteraction: { create: jest.fn().mockResolvedValue({ id: BigInt(42) }) },
    alert: { findMany: jest.fn().mockResolvedValue([]) },
    pricingRecommendation: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function makeLlm(available = true) {
  return { available, model: 'gpt-test', complete: jest.fn() };
}

const RULES_SKU = {
  stockItemId: 10,
  sku: 'SKU-10',
  productName: 'Sữa tươi',
  question: 'q',
  explanation: 'RULES TEXT',
  factualContext: { product: { id: 10, sku: 'SKU-10', name: 'Sữa tươi', sellingPrice: 30000 }, inventory: { available: 3 } },
};

function makeService(overrides: { llm?: ReturnType<typeof makeLlm>; prisma?: ReturnType<typeof makePrisma>; rules?: any; engine?: any } = {}) {
  const prisma = overrides.prisma ?? makePrisma();
  const llm = overrides.llm ?? makeLlm();
  const rules = overrides.rules ?? {
    explainSku: jest.fn().mockResolvedValue({ ...RULES_SKU }),
    explainStoreOverview: jest.fn().mockResolvedValue({ summary: 'RULES SUMMARY', metrics: { totalSkus: 4 }, openAlertsCount: 1, pendingRecommendationsCount: 0 }),
    answerQuestion: jest.fn().mockResolvedValue({ answer: 'RULES ANSWER', actionLinks: [], dataSnapshot: { top: [] } }),
  };
  const engine = overrides.engine ?? { getSkuDecision: jest.fn() };
  const service = new AiDecisionService(prisma as any, rules, llm as any, engine);
  return { service, prisma, llm, rules, engine };
}

const llmOk = (text: string, json?: unknown) => ({ text, json, model: 'gpt-test-2025', inputTokens: 210, outputTokens: 80, latencyMs: 900 });

describe('AiDecisionService', () => {
  describe('explainSku', () => {
    it('explains with AI over the role-filtered facts and records tokens', async () => {
      const { service, llm, prisma } = makeService();
      llm.complete.mockResolvedValue(llmOk('AI TEXT'));

      const result = await service.explainSku(1, 10, undefined, 'SHOP_OWNER', 7);

      expect(result).toMatchObject({ explanation: 'AI TEXT', source: 'AI', model: 'gpt-test-2025', interactionId: '42' });
      const request = llm.complete.mock.calls[0][0];
      expect(request.input).toContain('<data>');
      expect(request.input).toContain('"sku": "SKU-10"');
      expect(request.instructions).not.toContain('NHÂN VIÊN KHO');
      expect(prisma.aiInteraction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          storeId: 1, userId: 7, status: 'SUCCESS', inputTokens: 210, outputTokens: 80, latencyMs: 900,
          contextSummaryJson: { feature: 'SKU_EXPLAIN', source: 'AI' },
        }),
        select: { id: true },
      });
    });

    it('adds the staff restriction to the instructions for warehouse staff', async () => {
      const { service, llm } = makeService();
      llm.complete.mockResolvedValue(llmOk('AI TEXT'));
      await service.explainSku(1, 10, 'Còn bao nhiêu?', 'WAREHOUSE_STAFF', 8);
      expect(llm.complete.mock.calls[0][0].instructions).toContain('NHÂN VIÊN KHO');
    });

    it('falls back to the rule-based text when the model times out', async () => {
      const { service, llm, prisma } = makeService();
      llm.complete.mockRejectedValue(new LlmUnavailableError('TIMEOUT', 'timed out'));

      const result = await service.explainSku(1, 10, undefined, 'SHOP_OWNER', 7);

      expect(result).toMatchObject({ explanation: 'RULES TEXT', source: 'RULES', fallbackReason: 'TIMEOUT' });
      expect(prisma.aiInteraction.create.mock.calls[0][0].data).toMatchObject({
        status: 'TIMEOUT', model: 'gpt-test', contextSummaryJson: { feature: 'SKU_EXPLAIN', source: 'RULES', fallbackReason: 'TIMEOUT' },
      });
    });

    it('never calls the model when AI is not configured', async () => {
      const llm = makeLlm(false);
      const { service } = makeService({ llm });
      const result = await service.explainSku(1, 10, undefined, 'SHOP_OWNER', 7);
      expect(result).toMatchObject({ explanation: 'RULES TEXT', source: 'RULES', fallbackReason: 'DISABLED' });
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  it('summarizes the overview with AI from metrics and top alerts', async () => {
    const { service, llm, prisma } = makeService();
    prisma.alert.findMany.mockResolvedValue([{ type: 'STOCKOUT', severity: 'CRITICAL', title: 'Hết hàng', stockItem: { sku: 'A', name: 'Táo' } }]);
    llm.complete.mockResolvedValue(llmOk('AI SUMMARY'));

    const result = await service.explainOverview(1, 'SHOP_OWNER', 7);

    expect(result).toMatchObject({ summary: 'AI SUMMARY', source: 'AI', metrics: { totalSkus: 4 } });
    expect(llm.complete.mock.calls[0][0].input).toContain('Hết hàng');
    expect(prisma.alert.findMany.mock.calls[0][0].where).toEqual({ storeId: 1, status: { in: ['OPEN', 'ACKNOWLEDGED'] } });
  });

  describe('chat', () => {
    it('answers from the facts gathered by the rule engine', async () => {
      const { service, llm } = makeService();
      llm.complete.mockResolvedValue(llmOk('AI ANSWER'));
      const result = await service.chat(1, 'Nên nhập gì?', undefined, 'SHOP_OWNER', 7);
      expect(result).toMatchObject({ answer: 'AI ANSWER', source: 'AI' });
      expect(llm.complete.mock.calls[0][0].input).toContain('RULES ANSWER');
    });

    it('returns the financial restriction message without calling the model', async () => {
      const rules = { answerQuestion: jest.fn().mockResolvedValue({ answer: FINANCIAL_DATA_RESTRICTED_MESSAGE, actionLinks: [] }) };
      const { service, llm } = makeService({ rules });
      const result = await service.chat(1, 'Lãi bao nhiêu?', undefined, 'WAREHOUSE_STAFF', 8);
      expect(result.answer).toBe(FINANCIAL_DATA_RESTRICTED_MESSAGE);
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  describe('suggestActions', () => {
    const recommendation = {
      id: 5, action: 'DECREASE', currentPrice: 50000, recommendedPrice: 42000, discountPct: 16, riskScore: 70, confidence: 80,
      stockItem: { sku: 'B', name: 'Bánh' },
    };
    const stockoutAlert = { id: 7, type: 'STOCKOUT', severity: 'CRITICAL', title: 'Sắp hết Sữa', stockItemId: 3, stockItem: { sku: 'S', name: 'Sữa' } };
    const engine = {
      getSkuDecision: jest.fn().mockResolvedValue({
        analysis: {
          sku: 'S', productName: 'Sữa', inventory: { available: 2 }, coverage: { reorderPoint: 12, reorderQuantity: 20, daysOfCover: 1 },
          engineConfig: { leadTimeDays: 7 },
        },
      }),
    };

    it('keeps only suggestions that point at this store’s candidates', async () => {
      const prisma = makePrisma();
      prisma.pricingRecommendation.findMany.mockResolvedValue([recommendation]);
      prisma.alert.findMany.mockResolvedValue([stockoutAlert]);
      const { service, llm } = makeService({ prisma, engine });
      llm.complete.mockResolvedValue(
        llmOk('{}', {
          suggestions: [
            { kind: 'REORDER', targetId: 3, title: 'Nhập 20 Sữa', reason: 'Còn 2', priority: 'HIGH' },
            { kind: 'APPROVE_PRICE', targetId: 999, title: 'Giá lạ', reason: 'x', priority: 'LOW' },
            { kind: 'ACK_ALERT', targetId: 7, title: 'Xử lý cảnh báo', reason: 'Nghiêm trọng', priority: 'HIGH' },
            { kind: 'ACK_ALERT', targetId: 5, title: 'Sai loại id', reason: 'x', priority: 'LOW' },
            { kind: 'APPROVE_PRICE', targetId: 5, title: 'Duyệt giá Bánh', reason: 'Rủi ro 70', priority: 'MEDIUM' },
          ],
        })
      );

      const result = await service.suggestActions(1, 'SHOP_OWNER', 7);

      expect(result.source).toBe('AI');
      expect(result.suggestions.map((s) => `${s.kind}:${s.targetId}`)).toEqual(['REORDER:3', 'ACK_ALERT:7', 'APPROVE_PRICE:5']);
      expect(llm.complete.mock.calls[0][0].jsonSchema.name).toBe('action_suggestions');
      expect(prisma.pricingRecommendation.findMany.mock.calls[0][0].where).toEqual({ storeId: 1, status: 'PENDING' });
      expect(prisma.alert.findMany.mock.calls[0][0].where).toEqual({ storeId: 1, status: 'OPEN' });
    });

    it('never reads or suggests pricing for warehouse staff', async () => {
      const prisma = makePrisma();
      prisma.alert.findMany.mockResolvedValue([stockoutAlert]);
      const { service, llm } = makeService({ prisma, engine });
      llm.complete.mockResolvedValue(
        llmOk('{}', { suggestions: [{ kind: 'APPROVE_PRICE', targetId: 5, title: 'x', reason: 'x', priority: 'HIGH' }] })
      );

      const result = await service.suggestActions(1, 'WAREHOUSE_STAFF', 8);

      expect(prisma.pricingRecommendation.findMany).not.toHaveBeenCalled();
      expect(llm.complete.mock.calls[0][0].input).not.toContain('recommendedPrice');
      expect(result.suggestions.every((s) => s.kind !== 'APPROVE_PRICE' && s.kind !== 'REJECT_PRICE')).toBe(true);
    });

    it('ranks candidates by rules when AI is unavailable', async () => {
      const prisma = makePrisma();
      prisma.pricingRecommendation.findMany.mockResolvedValue([recommendation]);
      prisma.alert.findMany.mockResolvedValue([stockoutAlert]);
      const llm = makeLlm(false);
      const { service } = makeService({ prisma, engine, llm });

      const result = await service.suggestActions(1, 'SHOP_OWNER', 7);

      expect(result.source).toBe('RULES');
      expect(result.suggestions.map((s) => s.kind)).toEqual(['REORDER', 'ACK_ALERT', 'APPROVE_PRICE']);
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('returns an empty list without calling the model when nothing needs attention', async () => {
      const { service, llm } = makeService();
      const result = await service.suggestActions(1, 'SHOP_OWNER', 7);
      expect(result.suggestions).toEqual([]);
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  it('rankSuggestionsByRules caps the list at six items', () => {
    const alerts = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, type: 'OVERSTOCK', severity: 'WARNING', title: `C${i}`, sku: `S${i}` }));
    expect(rankSuggestionsByRules({ pricing: [], alerts, reorder: [] })).toHaveLength(6);
  });
});
