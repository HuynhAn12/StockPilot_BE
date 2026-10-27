import { Role } from '@prisma/client';
import { canViewFinancials } from '../../common/utils/role-access';
import type { SkuDecisionAnalysisResult } from './decision-engine.service';
import type { ResolvedEngineConfig } from './engine-config.service';

/**
 * Role-based projections of Decision Engine output (D9 / PRI-003).
 *
 * Staff views are built from an explicit allowlist rather than by deleting keys, so a field added
 * to the owner result later is hidden from staff by default. The global sensitive-fields
 * middleware remains as a second layer.
 */

export type StaffEngineConfigView = Omit<ResolvedEngineConfig, 'minimumMarginPct' | 'maxMarkdownPct' | 'maxMarkupPct'>;

export type StaffSkuDecisionView = Pick<
  SkuDecisionAnalysisResult,
  | 'stockItemId'
  | 'sku'
  | 'productName'
  | 'categoryName'
  | 'inventory'
  | 'dataStatus'
  | 'historyDays'
  | 'demand'
  | 'coverage'
  | 'confidence'
  | 'engineVersion'
  | 'calculatedAt'
> & {
  risk: Omit<SkuDecisionAnalysisResult['risk'], 'deadStockCostValue'>;
  pricing: { sellingPrice: number };
  engineConfig: StaffEngineConfigView;
  /** Pricing factors are owner-only; kept as an empty list so list rendering does not break. */
  factors: [];
};

export type SkuDecisionView = SkuDecisionAnalysisResult | StaffSkuDecisionView;

export interface DecisionOverviewSummary {
  totalSkus: number;
  stockoutRiskCount: number;
  overstockRiskCount: number;
  deadStockCount: number;
  totalDeadStockCostValue: number;
  totalDeadStockRetailValue: number;
}

export type StaffDecisionOverviewSummary = Omit<DecisionOverviewSummary, 'totalDeadStockCostValue'>;

export function toEngineConfigView(
  config: ResolvedEngineConfig,
  role?: Role | string | null
): ResolvedEngineConfig | StaffEngineConfigView {
  if (canViewFinancials(role)) {
    return config;
  }

  return {
    leadTimeDays: config.leadTimeDays,
    safetyDays: config.safetyDays,
    serviceLevel: config.serviceLevel,
    targetCoverageDays: config.targetCoverageDays,
    slowMovingDays: config.slowMovingDays,
    deadStockDays: config.deadStockDays,
    minimumHistoryDays: config.minimumHistoryDays,
    lowRiskThreshold: config.lowRiskThreshold,
    highRiskThreshold: config.highRiskThreshold,
    criticalRiskThreshold: config.criticalRiskThreshold,
    engineVersion: config.engineVersion,
    source: config.source,
  };
}

export function toSkuDecisionView(result: SkuDecisionAnalysisResult, role?: Role | string | null): SkuDecisionView {
  if (canViewFinancials(role)) {
    return result;
  }

  return {
    stockItemId: result.stockItemId,
    sku: result.sku,
    productName: result.productName,
    categoryName: result.categoryName,
    inventory: result.inventory,
    dataStatus: result.dataStatus,
    historyDays: result.historyDays,
    demand: result.demand,
    coverage: result.coverage,
    risk: {
      stockout: result.risk.stockout,
      stockoutSeverity: result.risk.stockoutSeverity,
      overstock: result.risk.overstock,
      overstockSeverity: result.risk.overstockSeverity,
      slowMoving: result.risk.slowMoving,
      deadStock: result.risk.deadStock,
      deadStockSeverity: result.risk.deadStockSeverity,
      daysSinceLastSale: result.risk.daysSinceLastSale,
      daysWithoutSale: result.risk.daysWithoutSale,
      deadStockRetailValue: result.risk.deadStockRetailValue,
      unusualDemand: result.risk.unusualDemand,
    },
    confidence: result.confidence,
    pricing: { sellingPrice: result.pricing.sellingPrice },
    engineConfig: toEngineConfigView(result.engineConfig, role) as StaffEngineConfigView,
    engineVersion: result.engineVersion,
    factors: [],
    calculatedAt: result.calculatedAt,
  };
}

export function toOverviewSummaryView(
  summary: DecisionOverviewSummary,
  role?: Role | string | null
): DecisionOverviewSummary | StaffDecisionOverviewSummary {
  if (canViewFinancials(role)) {
    return summary;
  }

  return {
    totalSkus: summary.totalSkus,
    stockoutRiskCount: summary.stockoutRiskCount,
    overstockRiskCount: summary.overstockRiskCount,
    deadStockCount: summary.deadStockCount,
    totalDeadStockRetailValue: summary.totalDeadStockRetailValue,
  };
}
