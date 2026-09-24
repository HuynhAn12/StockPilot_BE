import { z } from 'zod';

export const pricingListQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'MODIFIED', 'EXPIRED']).optional(),
  stockItemId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const pricingActionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const modifyRecommendationSchema = z.object({
  customPrice: z.coerce.number().positive('Giá sửa đổi phải lớn hơn 0'),
  applyToStockItem: z.boolean().default(true),
});

export const acceptRecommendationSchema = z.object({
  applyToStockItem: z.boolean().default(true),
});
