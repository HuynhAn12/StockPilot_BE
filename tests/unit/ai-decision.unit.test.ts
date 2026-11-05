import { AiDecisionService } from '../../src/modules/assistant/ai-decision.service';
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
      expect(request.input).toContain('<store_data>');
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
    const NOW = new Date('2026-11-01T03:00:00Z');
    const recommendation = {
      id: 5, stockItemId: 9, action: 'DECREASE', currentPrice: 50000, recommendedPrice: 42000, riskScore: 70, confidence: 80,
      createdAt: NOW, stockItem: { sku: 'B', name: 'Bánh' },
    };
    const stockoutAlert = {
      id: 7, stockItemId: 3, type: 'STOCKOUT', severity: 'CRITICAL', title: 'Sắp hết Sữa', riskScore: 90, confidence: 95,
      openedAt: NOW, stockItem: { sku: 'S', name: 'Sữa' },
    };
    const overstockAlert = {
      id: 8, stockItemId: 4, type: 'OVERSTOCK', severity: 'WARNING', title: 'Tồn nhiều Kẹo', riskScore: 40, confidence: 80,
      openedAt: NOW, stockItem: { sku: 'K', name: 'Kẹo' },
    };
    const makeEngine = () => ({
      getSkuDecision: jest.fn().mockResolvedValue({
        analysis: {
          sku: 'S', productName: 'Sữa', inventory: { available: 2 }, coverage: { reorderPoint: 12, reorderQuantity: 20, daysOfCover: 1 },
          engineConfig: { leadTimeDays: 7 },
        },
      }),
    });

    it('ranks store candidates without the language model and writes nothing', async () => {
      const prisma = makePrisma();
      prisma.pricingRecommendation.findMany.mockResolvedValue([recommendation]);
      prisma.alert.findMany.mockResolvedValue([stockoutAlert, overstockAlert]);
      const { service, llm } = makeService({ prisma, engine: makeEngine() });

      const result = await service.suggestActions(1, 'SHOP_OWNER', NOW);

      expect(result).toMatchObject({ source: 'RULES', model: 'StockPilot-Rules-v2', generatedAt: NOW.toISOString() });
      // The reorder for SKU 3 replaces that SKU's stock-out alert; the rest follow by score.
      expect(result.suggestions.map((s) => `${s.kind}:${s.targetId}`)).toEqual(['REORDER:3', 'APPROVE_PRICE:5', 'ACK_ALERT:8']);
      expect(result.suggestions[0]).toMatchObject({ priority: 'HIGH', score: expect.any(Number) });
      expect(llm.complete).not.toHaveBeenCalled();
      expect(prisma.aiInteraction.create).not.toHaveBeenCalled();
      expect(prisma.pricingRecommendation.findMany.mock.calls[0][0].where).toEqual({
        storeId: 1, status: 'PENDING', action: { not: 'MAINTAIN' }, OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
      });
      expect(prisma.alert.findMany.mock.calls[0][0].where).toEqual({ storeId: 1, status: 'OPEN' });
    });

    it('never reads or suggests pricing for warehouse staff', async () => {
      const prisma = makePrisma();
      prisma.alert.findMany.mockResolvedValue([stockoutAlert, overstockAlert]);
      const { service } = makeService({ prisma, engine: makeEngine() });

      const result = await service.suggestActions(1, 'WAREHOUSE_STAFF', NOW);

      expect(prisma.pricingRecommendation.findMany).not.toHaveBeenCalled();
      expect(result.suggestions.every((s) => s.kind !== 'APPROVE_PRICE' && s.kind !== 'REJECT_PRICE')).toBe(true);
      // Không lộ số tiền (định dạng "42.000 đ") cho nhân viên kho.
      expect(result.suggestions.some((s) => /\d{1,3}(\.\d{3})+ đ/.test(s.reason))).toBe(false);
    });

    it('still ranks the alerts when a Decision Engine lookup fails', async () => {
      const prisma = makePrisma();
      prisma.alert.findMany.mockResolvedValue([stockoutAlert, overstockAlert]);
      const engine = { getSkuDecision: jest.fn().mockRejectedValue(new Error('engine down')) };
      const { service } = makeService({ prisma, engine });

      const result = await service.suggestActions(1, 'SHOP_OWNER', NOW);

      expect(result.suggestions.map((s) => `${s.kind}:${s.targetId}`)).toEqual(['ACK_ALERT:7', 'ACK_ALERT:8']);
    });

    it('returns an empty list when nothing needs attention', async () => {
      const { service, llm, engine } = makeService();
      const result = await service.suggestActions(1, 'SHOP_OWNER', NOW);
      expect(result.suggestions).toEqual([]);
      expect(engine.getSkuDecision).not.toHaveBeenCalled();
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });
});
