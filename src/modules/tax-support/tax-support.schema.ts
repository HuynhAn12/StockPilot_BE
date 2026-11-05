import { z } from 'zod';

export const revenueBookQuerySchema = z
  .object({
    template: z.enum(['S1A', 'S2A']),
    period: z.enum(['month', 'quarter', 'year']),
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12).optional(),
    quarter: z.coerce.number().int().min(1).max(4).optional(),
    granularity: z.enum(['day', 'order']).default('day'),
  })
  .superRefine((q, ctx) => {
    if (q.period === 'month' && q.month === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['month'], message: 'Cần chọn tháng' });
    }
    if (q.period === 'quarter' && q.quarter === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quarter'], message: 'Cần chọn quý' });
    }
  });

export type RevenueBookQuery = z.infer<typeof revenueBookQuerySchema>;
