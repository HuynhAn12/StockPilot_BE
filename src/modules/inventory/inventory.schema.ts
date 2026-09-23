import { z } from 'zod';

const inflowItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  quantity: z.number().int().positive('Số lượng nhập phải lớn hơn 0'),
});

export const inflowSchema = z.object({
  warehouseId: z.number().int().optional(),
  items: z.array(inflowItemSchema).min(1, 'Danh sách mặt hàng nhập không được rỗng'),
  referenceId: z.string().optional(),
  note: z.string().optional(),
});

const outflowItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  quantity: z.number().int().positive('Số lượng xuất phải lớn hơn 0'),
});

export const outflowSchema = z.object({
  warehouseId: z.number().int().optional(),
  items: z.array(outflowItemSchema).min(1, 'Danh sách mặt hàng xuất không được rỗng'),
  referenceId: z.string().optional(),
  note: z.string().optional(),
});

const auditItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  countedQuantity: z.number().int().min(0, 'Số lượng kiểm kê thực tế không được âm'),
});

export const auditSchema = z.object({
  warehouseId: z.number().int().optional(),
  items: z.array(auditItemSchema).min(1, 'Danh sách mặt hàng kiểm kê không được rỗng'),
  referenceId: z.string().optional(),
  note: z.string().optional(),
});
