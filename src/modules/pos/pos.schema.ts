import { z } from 'zod';

const posSaleItemSchema = z
  .object({
    stockItemId: z.number().int().positive(),
    quantity: z.number().int().positive('POS sale quantity must be greater than 0'),
    price: z.coerce.number().min(0).optional(),
    unitPrice: z.coerce.number().min(0).optional(),
  })
  .passthrough();

export const createPosSaleSchema = z
  .object({
    warehouseId: z.number().int().positive().optional(),
    customerName: z.string().trim().max(255).optional(),
    customerPhone: z.string().trim().max(50).optional(),
    discountAmount: z.coerce.number().min(0).default(0),
    taxAmount: z.coerce.number().min(0).default(0),
    note: z.string().trim().optional(),
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'PAYOS', 'MOMO']).default('CASH'),
    totalAmount: z.coerce.number().min(0).optional(),
    items: z.array(posSaleItemSchema).min(1, 'POS sale must contain at least one item'),
  })
  .passthrough();
