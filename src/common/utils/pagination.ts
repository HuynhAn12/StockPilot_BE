import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive({ message: 'ID phải là số nguyên dương' }),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const productListQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  isActive: z.preprocess((val) => {
    if (val === 'true' || val === true) return true;
    if (val === 'false' || val === false) return false;
    return val;
  }, z.boolean().optional()),
});

export const orderListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(['DRAFT', 'CONFIRMED', 'FULFILLED', 'CANCELED']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return data.from <= data.to;
      }
      return true;
    },
    {
      message: 'Khoảng thời gian không hợp lệ: "from" phải trước hoặc bằng "to"',
      path: ['from'],
    }
  );


export const movementListQuerySchema = paginationQuerySchema.extend({
  stockItemId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  type: z.enum([
    'INFLOW',
    'OUTFLOW',
    'AUDIT_ADJUSTMENT',
    'ORDER_FULFILL',
    'ORDER_CANCEL_RESTOCK',
    'RETURN_RESTOCK',
  ]).optional(),
});

export const inventoryBalanceQuerySchema = paginationQuerySchema.extend({
  warehouseId: z.coerce.number().int().positive().optional(),
  stockItemId: z.coerce.number().int().positive().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
export type MovementListQuery = z.infer<typeof movementListQuerySchema>;

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function buildPaginationResult<T>(items: T[], total: number, page: number, limit: number): PaginatedResult<T> {
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export function sanitizeSortField(
  sortField: string | undefined,
  allowedFields: string[],
  fallback: string = 'createdAt'
): string {
  if (!sortField) return fallback;
  return allowedFields.includes(sortField) ? sortField : fallback;
}
