import { z } from 'zod';

export const explainSkuQuerySchema = z.object({
  stockItemId: z.coerce.number().int().positive(),
  question: z.string().trim().optional(),
});

export const explainPricingQuerySchema = z.object({
  recommendationId: z.coerce.number().int().positive(),
});

export const storeSummaryQuerySchema = z.object({
  timeframeDays: z.coerce.number().int().min(7).max(90).default(30),
});
