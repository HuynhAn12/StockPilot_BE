import { z } from 'zod';

const posSaleItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  quantity: z.number().int().positive('POS sale quantity must be greater than 0'),
});

export const createPosSaleSchema = z
  .object({
    warehouseId: z.number().int().positive().optional(),
    customerName: z.string().trim().max(255).optional(),
    customerPhone: z.string().trim().max(50).optional(),
    discountAmount: z.coerce.number().min(0).default(0),
    taxAmount: z.coerce.number().min(0).default(0),
    note: z.string().trim().optional(),
    paymentMethod: z.literal('CASH').default('CASH'),
    items: z.array(posSaleItemSchema).min(1, 'POS sale must contain at least one item'),
  })
  .strict();
