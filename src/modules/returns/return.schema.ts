import { z } from 'zod';

const returnItemInputSchema = z.object({
  orderItemId: z.number().int().positive(),
  quantity: z.number().int().positive('Số lượng trả phải lớn hơn 0'),
  isRestockable: z.boolean().default(true),
  note: z.string().optional(),
});

export const createReturnSchema = z.object({
  orderId: z.number().int().positive(),
  reason: z.string().min(1, 'Lý do trả hàng không được để trống'),
  items: z.array(returnItemInputSchema).min(1, 'Phải có ít nhất 1 mặt hàng hoàn trả'),
});
