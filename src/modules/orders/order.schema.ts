import { z } from 'zod';

const orderItemInputSchema = z.object({
  stockItemId: z.number().int().positive(),
  quantity: z.number().int().positive('Số lượng đặt phải lớn hơn 0'),
});

export const createOrderSchema = z.object({
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerAddress: z.string().optional(),
  discountAmount: z.coerce.number().min(0).default(0),
  taxAmount: z.coerce.number().min(0).default(0),
  note: z.string().optional(),
  items: z.array(orderItemInputSchema).min(1, 'Đơn hàng phải có ít nhất 1 sản phẩm'),
});

export const cancelOrderSchema = z.object({
  cancelReason: z.string().min(1, 'Lý do hủy đơn không được để trống'),
});
