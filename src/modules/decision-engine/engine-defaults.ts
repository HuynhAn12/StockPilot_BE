/**
 * Pure Decision Engine constants (no database imports) so evaluators stay side-effect free.
 */

/**
 * Version of the deterministic formulas. It is a property of the code, not of a store's config:
 * snapshots record it and are reported stale when it differs from the running engine.
 * V2: complete-day windows, exposure-based history, sample σ, Φ⁻¹ service level, config-driven
 * dead-stock thresholds, σ/√n anomaly test, INSUFFICIENT_DATA gating, reorder quantity.
 */
export const DECISION_ENGINE_VERSION = 'DECISION_ENGINE_V2';

export interface ResolvedEngineConfig {
  leadTimeDays: number;
  safetyDays: number;
  serviceLevel: number;
  targetCoverageDays: number;
  slowMovingDays: number;
  deadStockDays: number;
  minimumHistoryDays: number;
  minimumMarginPct: number;
  maxMarkdownPct: number;
  maxMarkupPct: number;
  lowRiskThreshold: number;
  highRiskThreshold: number;
  criticalRiskThreshold: number;
  engineVersion: string;
  source: 'DEFAULT' | 'CUSTOM';
}

export const DEFAULT_ENGINE_CONFIG: ResolvedEngineConfig = {
  leadTimeDays: 7,
  safetyDays: 3,
  serviceLevel: 0.95,
  targetCoverageDays: 30,
  slowMovingDays: 60,
  deadStockDays: 90,
  minimumHistoryDays: 14,
  minimumMarginPct: 0.20,
  maxMarkdownPct: 0.30,
  maxMarkupPct: 0.20,
  lowRiskThreshold: 25,
  highRiskThreshold: 50,
  criticalRiskThreshold: 75,
  engineVersion: DECISION_ENGINE_VERSION,
  source: 'DEFAULT',
};
