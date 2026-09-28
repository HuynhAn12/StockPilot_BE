import { StockTakeStatus } from '@prisma/client';
import { z } from 'zod';

export const stockTakeIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createStockTakeSchema = z.object({
  warehouseId: z.number().int().positive(),
  note: z.string().max(2000).optional(),
});

const countItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  countedQuantity: z.number().int().min(0, 'Counted quantity must be non-negative'),
  note: z.string().max(2000).optional(),
});

export const updateStockTakeCountsSchema = z.object({
  items: z.array(countItemSchema).min(1, 'At least one counted item is required'),
});

export const stockTakeListQuerySchema = z.object({
  status: z.nativeEnum(StockTakeStatus).optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateStockTakeInput = z.infer<typeof createStockTakeSchema>;
export type UpdateStockTakeCountsInput = z.infer<typeof updateStockTakeCountsSchema>;
export type StockTakeListQuery = z.infer<typeof stockTakeListQuerySchema>;
