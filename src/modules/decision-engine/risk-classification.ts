/**
 * Single source of truth for turning risk scores into risk categories. Both the overview
 * (counts and filters) and the alert sync use it, so the dashboard and the alert list can never
 * disagree about which SKUs are at risk.
 */
export interface RiskClassificationInput {
  availableStock: number;
  reorderPoint: number;
  stockoutScore: number;
  overstockScore: number;
  isDeadStock: boolean;
  highRiskThreshold: number;
}

export interface RiskClassification {
  /** Out of stock, at or below the reorder point, or a high stockout score. */
  stockoutRisk: boolean;
  outOfStock: boolean;
  /** Overstock score at or above the store's high-risk threshold. */
  overstockRisk: boolean;
  deadStock: boolean;
}

export function classifyRisk(input: RiskClassificationInput): RiskClassification {
  const outOfStock = input.availableStock <= 0;
  return {
    outOfStock,
    stockoutRisk: outOfStock || input.availableStock <= input.reorderPoint || input.stockoutScore >= input.highRiskThreshold,
    overstockRisk: input.overstockScore >= input.highRiskThreshold,
    deadStock: input.isDeadStock,
  };
}
