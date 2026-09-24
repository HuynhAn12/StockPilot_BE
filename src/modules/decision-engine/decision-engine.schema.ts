import { z } from 'zod';

export const decisionSkuParamsSchema = z.object({
  stockItemId: z.coerce.number().int().positive(),
});

export const decisionOverviewQuerySchema = z.object({
  riskFilter: z.enum(['ALL', 'STOCKOUT', 'OVERSTOCK', 'DEAD_STOCK']).default('ALL'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const updateEngineConfigSchema = z.object({
  leadTimeDays: z.coerce.number().int().min(1).max(365).optional(),
  safetyDays: z.coerce.number().int().min(0).max(365).optional(),
  serviceLevel: z.coerce.number().min(0.5).max(0.999).optional(),
  targetCoverageDays: z.coerce.number().int().min(1).max(365).optional(),
  slowMovingDays: z.coerce.number().int().min(1).max(365).optional(),
  deadStockDays: z.coerce.number().int().min(1).max(730).optional(),
  minimumHistoryDays: z.coerce.number().int().min(1).max(365).optional(),
  minimumMarginPct: z.coerce.number().min(0).max(1).optional(),
  maxMarkdownPct: z.coerce.number().min(0).max(1).optional(),
  maxMarkupPct: z.coerce.number().min(0).max(1).optional(),
  lowRiskThreshold: z.coerce.number().int().min(0).max(100).optional(),
  highRiskThreshold: z.coerce.number().int().min(0).max(100).optional(),
  criticalRiskThreshold: z.coerce.number().int().min(0).max(100).optional(),
});

// Backward compatibility alias
export const updatePolicySchema = updateEngineConfigSchema;
