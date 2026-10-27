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

export const assistantChatBodySchema = z.object({
  question: z.string().trim().max(1000, 'Câu hỏi tối đa 1000 ký tự').optional().default(''),
  stockItemId: z.coerce.number().int().positive().optional(),
});
