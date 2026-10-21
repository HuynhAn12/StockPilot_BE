import { z } from 'zod';

export const alertListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val.toUpperCase() === 'ALL') return undefined;
      return val.toUpperCase();
    })
    .pipe(z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional()),
  type: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val.toUpperCase() === 'ALL') return undefined;
      return val.toUpperCase();
    })
    .pipe(z.enum(['LOW_STOCK', 'STOCKOUT', 'OVERSTOCK', 'SLOW_MOVING', 'DEAD_STOCK', 'UNUSUAL_DEMAND']).optional()),
  severity: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val.toUpperCase() === 'ALL') return undefined;
      return val.toUpperCase();
    })
    .pipe(z.enum(['INFO', 'WARNING', 'CRITICAL']).optional()),
  stockItemId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const alertActionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
