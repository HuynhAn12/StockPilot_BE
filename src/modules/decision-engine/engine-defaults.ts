/**
 * Pure Decision Engine constants (no database imports) so evaluators stay side-effect free.
 */

/**
 * Version of the deterministic formulas. It is a property of the code, not of a store's config:
 * snapshots record it and are reported stale when it differs from the running engine.
 * V2: complete-day windows, exposure-based history, sample σ, Φ⁻¹ service level, config-driven
 * dead-stock thresholds, σ/√n anomaly test, INSUFFICIENT_DATA gating, reorder quantity.
 */
// V2.1: graded overstock score (no clamped plateau, replenishment guard, volume-aware trend). Bumping the
// version marks every older snapshot stale, so scores are recomputed with the new formula.
// V2.2: pricing triggers follow the store config (highRiskThreshold for the overstock markdown and the
// stockout markup, targetCoverageDays × 1.5 for excess cover). With the default config the markup
// trigger moves from a fixed 60 to 50, so pricing output changes and older snapshots must be recomputed.
export const DECISION_ENGINE_VERSION = 'DECISION_ENGINE_V2.2';

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
  /**
   * Version of the store's settings: 'DEFAULT' when the store has no EngineConfig row, otherwise the
   * ISO time of its last update. Snapshots keep it, so every result names the settings it used.
   * 'UNKNOWN' on snapshots written before this field existed.
   */
  configVersion: string;
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
  configVersion: 'DEFAULT',
  source: 'DEFAULT',
};
