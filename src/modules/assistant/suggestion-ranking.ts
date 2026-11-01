/**
 * Deterministic "next best action" ranking for the assistant's suggestion panel.
 *
 * Every candidate gets a score in [0, 100]:
 *   score = 100 × (0.45·urgency + 0.35·impact + 0.20·confidence) + aging   (aging ≤ 8 points)
 * - urgency: how soon it hurts (stock-out now = 1; days of cover vs. lead time; alert severity; pricing risk).
 * - impact: how much it matters (Decision Engine risk score; size of the price change).
 * - confidence: the engine's own confidence in the signal.
 * - aging: +1 point per day open, so old items are not starved by a stream of new ones.
 * Then: one suggestion per SKU (a reorder supersedes that SKU's stock-out/low-stock alert),
 * at most MAX_PER_KIND of one kind in the list, ties broken by kind then id so the order is stable.
 * Pure function: no I/O, same input → same output.
 */

export type SuggestionKind = 'APPROVE_PRICE' | 'REJECT_PRICE' | 'ACK_ALERT' | 'REORDER';
export type SuggestionPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ActionSuggestion {
  kind: SuggestionKind;
  /** pricing recommendation id (APPROVE/REJECT_PRICE), alert id (ACK_ALERT) or stock item id (REORDER). */
  targetId: number;
  title: string;
  reason: string;
  priority: SuggestionPriority;
  /** 0–100, higher = do it sooner. */
  score: number;
}

export interface AlertCandidate {
  id: number;
  stockItemId: number;
  type: string;
  severity: string;
  title: string;
  sku: string;
  riskScore: number | null;
  confidence: number | null;
  openedAt: Date;
}

export interface PricingCandidate {
  id: number;
  stockItemId: number;
  sku: string;
  name: string;
  action: string;
  currentPrice: number;
  recommendedPrice: number;
  riskScore: number | null;
  confidence: number | null;
  createdAt: Date;
}

export interface ReorderCandidate {
  stockItemId: number;
  sku: string;
  name: string;
  available: number;
  reorderQuantity: number;
  daysOfCover: number | null;
  leadTimeDays: number;
  /** Risk/confidence of the stock-out/low-stock alert that raised this reorder. */
  riskScore: number | null;
  confidence: number | null;
  openedAt: Date;
}

export interface SuggestionCandidates {
  alerts: AlertCandidate[];
  pricing: PricingCandidate[];
  reorder: ReorderCandidate[];
}

export const MAX_SUGGESTIONS = 6;
export const MAX_PER_KIND = 3;

const WEIGHTS = { urgency: 0.45, impact: 0.35, confidence: 0.2 } as const;
const MAX_AGING_POINTS = 8;
/** A price change of this fraction or more counts as full impact. */
const FULL_IMPACT_PRICE_CHANGE = 0.2;
const SEVERITY_URGENCY: Record<string, number> = { CRITICAL: 1, WARNING: 0.6, INFO: 0.25 };
const KIND_ORDER: Record<SuggestionKind, number> = { REORDER: 0, ACK_ALERT: 1, APPROVE_PRICE: 2, REJECT_PRICE: 3 };
const DAY_MS = 86_400_000;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** Engine scores are stored 0–100; null means "not provided". */
const pct = (value: number | null, fallback: number) => (value == null ? fallback : clamp01(value / 100));

function aging(since: Date, now: Date): number {
  const days = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  return Math.min(MAX_AGING_POINTS, Math.max(0, days));
}

function score(urgency: number, impact: number, confidence: number, agingPoints: number): number {
  const base = 100 * (WEIGHTS.urgency * clamp01(urgency) + WEIGHTS.impact * clamp01(impact) + WEIGHTS.confidence * clamp01(confidence));
  return Math.min(100, Math.round(base + agingPoints));
}

export function priorityOf(value: number): SuggestionPriority {
  if (value >= 70) return 'HIGH';
  if (value >= 45) return 'MEDIUM';
  return 'LOW';
}

const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')} đ`;

type Scored = ActionSuggestion & { stockItemId: number };

function scoreReorder(r: ReorderCandidate, now: Date): Scored {
  const lead = Math.max(1, r.leadTimeDays);
  const urgency = r.available <= 0 ? 1 : r.daysOfCover == null ? 0.7 : 1 - r.daysOfCover / (2 * lead);
  const value = score(urgency, pct(r.riskScore, 0.7), pct(r.confidence, 0.9), aging(r.openedAt, now));
  const cover = r.available <= 0
    ? 'Đã hết hàng'
    : `Còn ${r.available} đơn vị${r.daysOfCover != null ? `, đủ bán khoảng ${r.daysOfCover} ngày` : ''}`;
  return {
    kind: 'REORDER', targetId: r.stockItemId, stockItemId: r.stockItemId, score: value, priority: priorityOf(value),
    title: `Nhập thêm ${r.reorderQuantity} ${r.name}`.slice(0, 70),
    reason: `${cover}; thời gian chờ hàng ${r.leadTimeDays} ngày. Decision Engine đề xuất nhập ${r.reorderQuantity}.`,
  };
}

function scoreAlert(a: AlertCandidate, now: Date): Scored {
  const urgency = SEVERITY_URGENCY[a.severity] ?? 0.4;
  const value = score(urgency, pct(a.riskScore, urgency), pct(a.confidence, 1), aging(a.openedAt, now));
  const days = aging(a.openedAt, now);
  return {
    kind: 'ACK_ALERT', targetId: a.id, stockItemId: a.stockItemId, score: value, priority: priorityOf(value),
    title: `${a.severity === 'CRITICAL' ? 'Xử lý' : 'Xem'} cảnh báo: ${a.title}`.slice(0, 70),
    reason: `Cảnh báo ${a.severity.toLowerCase()} cho mã ${a.sku}${a.riskScore != null ? `, điểm rủi ro ${Math.round(a.riskScore)}` : ''}${days > 0 ? `, đã mở ${days} ngày` : ''}.`,
  };
}

function scorePricing(p: PricingCandidate, now: Date): Scored {
  const change = p.currentPrice > 0 ? Math.abs(p.recommendedPrice - p.currentPrice) / p.currentPrice : 0;
  const value = score(pct(p.riskScore, 0.3), change / FULL_IMPACT_PRICE_CHANGE, pct(p.confidence, 0.8), aging(p.createdAt, now));
  const direction = p.recommendedPrice < p.currentPrice ? 'giảm' : 'tăng';
  return {
    kind: 'APPROVE_PRICE', targetId: p.id, stockItemId: p.stockItemId, score: value, priority: priorityOf(value),
    title: `Xem đề xuất ${direction} giá ${p.name}`.slice(0, 70),
    reason: `Đổi giá từ ${vnd(p.currentPrice)} sang ${vnd(p.recommendedPrice)} (${Math.round(change * 100)}%)${p.riskScore != null ? `, điểm rủi ro ${Math.round(p.riskScore)}` : ''}.`,
  };
}

function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.targetId - b.targetId;
}

export function rankSuggestions(candidates: SuggestionCandidates, now: Date = new Date(), limit = MAX_SUGGESTIONS): ActionSuggestion[] {
  const scored = [
    ...candidates.reorder.map((r) => scoreReorder(r, now)),
    ...candidates.alerts.map((a) => scoreAlert(a, now)),
    ...candidates.pricing.map((p) => scorePricing(p, now)),
  ].sort(byScore);

  // One action per SKU; a reorder (sorted with its own score) also claims the SKU's stock alerts.
  const reorderSkus = new Set(candidates.reorder.map((r) => r.stockItemId));
  const perSku = new Map<number, Scored>();
  for (const s of scored) {
    if (s.kind === 'ACK_ALERT' && reorderSkus.has(s.stockItemId)) continue;
    if (!perSku.has(s.stockItemId)) perSku.set(s.stockItemId, s);
  }
  const unique = [...perSku.values()].sort(byScore);

  // Keep the list varied: at most MAX_PER_KIND of one kind, then top up if there is room left.
  const picked: Scored[] = [];
  const skipped: Scored[] = [];
  const perKind = new Map<SuggestionKind, number>();
  for (const s of unique) {
    if (picked.length >= limit) break;
    const count = perKind.get(s.kind) ?? 0;
    if (count >= MAX_PER_KIND) {
      skipped.push(s);
      continue;
    }
    perKind.set(s.kind, count + 1);
    picked.push(s);
  }
  for (const s of skipped) {
    if (picked.length >= limit) break;
    picked.push(s);
  }

  return picked.sort(byScore).map(({ stockItemId: _sku, ...rest }) => rest);
}
