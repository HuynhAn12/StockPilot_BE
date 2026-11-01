import {
  AlertCandidate, MAX_SUGGESTIONS, PricingCandidate, priorityOf, rankSuggestions, ReorderCandidate,
} from '../../src/modules/assistant/suggestion-ranking';

const NOW = new Date('2026-11-01T03:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const alert = (over: Partial<AlertCandidate> = {}): AlertCandidate => ({
  id: 1, stockItemId: 100, type: 'OVERSTOCK', severity: 'WARNING', title: 'Tồn nhiều', sku: 'A',
  riskScore: 50, confidence: 100, openedAt: NOW, ...over,
});
const pricing = (over: Partial<PricingCandidate> = {}): PricingCandidate => ({
  id: 1, stockItemId: 200, sku: 'P', name: 'Bánh', action: 'DECREASE', currentPrice: 100000, recommendedPrice: 90000,
  riskScore: 50, confidence: 80, createdAt: NOW, ...over,
});
const reorder = (over: Partial<ReorderCandidate> = {}): ReorderCandidate => ({
  stockItemId: 300, sku: 'R', name: 'Sữa', available: 5, reorderQuantity: 20, daysOfCover: 3, leadTimeDays: 7,
  riskScore: 80, confidence: 90, openedAt: NOW, ...over,
});
const keys = (list: Array<{ kind: string; targetId: number }>) => list.map((s) => `${s.kind}:${s.targetId}`);

describe('rankSuggestions', () => {
  it('puts an item that is already out of stock first', () => {
    const result = rankSuggestions({
      reorder: [reorder({ stockItemId: 1, available: 10, daysOfCover: 12 }), reorder({ stockItemId: 2, available: 0, daysOfCover: 0 })],
      alerts: [alert({ id: 9, stockItemId: 3, severity: 'CRITICAL', riskScore: 60 })],
      pricing: [],
    }, NOW);
    expect(keys(result)[0]).toBe('REORDER:2');
  });

  it('keeps one action per SKU and lets a reorder replace that SKU’s stock alert', () => {
    const result = rankSuggestions({
      reorder: [reorder({ stockItemId: 5 })],
      alerts: [
        alert({ id: 1, stockItemId: 5, type: 'STOCKOUT', severity: 'CRITICAL', riskScore: 99 }),
        alert({ id: 2, stockItemId: 6, riskScore: 10 }),
        alert({ id: 3, stockItemId: 6, riskScore: 90 }),
      ],
      pricing: [pricing({ id: 4, stockItemId: 5 })],
    }, NOW);
    expect(keys(result)).toEqual(['REORDER:5', 'ACK_ALERT:3']);
  });

  it('caps one kind at three while other kinds are available, then fills the rest', () => {
    const alerts = Array.from({ length: 8 }, (_, i) => alert({ id: i + 1, stockItemId: i + 1, severity: 'CRITICAL', riskScore: 95 }));
    const mixed = rankSuggestions({ reorder: [], alerts, pricing: [pricing({ id: 50, stockItemId: 99, riskScore: 5 })] }, NOW);
    expect(mixed).toHaveLength(MAX_SUGGESTIONS);
    expect(keys(mixed)).toContain('APPROVE_PRICE:50');

    const alertsOnly = rankSuggestions({ reorder: [], alerts, pricing: [] }, NOW);
    expect(alertsOnly).toHaveLength(MAX_SUGGESTIONS);
    expect(alertsOnly.every((s) => s.kind === 'ACK_ALERT')).toBe(true);
  });

  it('gives a bigger price change a higher score', () => {
    const [big, small] = rankSuggestions({
      reorder: [], alerts: [],
      pricing: [pricing({ id: 1, stockItemId: 1, recommendedPrice: 98000 }), pricing({ id: 2, stockItemId: 2, recommendedPrice: 80000 })],
    }, NOW);
    expect(big.targetId).toBe(2);
    expect(big.score).toBeGreaterThan(small.score);
  });

  it('adds one point per day open, up to eight', () => {
    const scoreAfter = (days: number) =>
      rankSuggestions({ reorder: [], alerts: [alert({ openedAt: daysAgo(days) })], pricing: [] }, NOW)[0].score;
    expect(scoreAfter(3) - scoreAfter(0)).toBe(3);
    expect(scoreAfter(30) - scoreAfter(0)).toBe(8);
  });

  it('is deterministic for equal scores (kind order, then id)', () => {
    const input = {
      reorder: [],
      alerts: [alert({ id: 20, stockItemId: 20 }), alert({ id: 10, stockItemId: 10 })],
      pricing: [],
    };
    expect(keys(rankSuggestions(input, NOW))).toEqual(['ACK_ALERT:10', 'ACK_ALERT:20']);
    expect(rankSuggestions(input, NOW)).toEqual(rankSuggestions(input, NOW));
  });

  it('keeps scores within 0–100 and maps them to priorities', () => {
    const [top] = rankSuggestions({
      reorder: [reorder({ available: 0, riskScore: 100, confidence: 100, openedAt: daysAgo(30) })], alerts: [], pricing: [],
    }, NOW);
    expect(top.score).toBe(100);
    expect([priorityOf(70), priorityOf(69), priorityOf(45), priorityOf(44)]).toEqual(['HIGH', 'MEDIUM', 'MEDIUM', 'LOW']);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankSuggestions({ reorder: [], alerts: [], pricing: [] }, NOW)).toEqual([]);
  });
});
