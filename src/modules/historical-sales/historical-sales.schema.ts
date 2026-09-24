import { z } from 'zod';

export const historicalSaleRowSchema = z.object({
  externalOrderId: z.string().trim().max(100).optional().nullable(),
  sku: z.string().trim().min(1, 'SKU không được để trống').max(100),
  quantity: z.coerce.number().int('Số lượng phải là số nguyên').positive('Số lượng bán phải lớn hơn 0'),
  unitPrice: z.coerce.number().min(0, 'Đơn giá không được âm'),
  soldAt: z.coerce.date({ errorMap: () => ({ message: 'Ngày bán soldAt không hợp lệ' }) }),
  source: z.string().trim().min(1).max(50).default('CSV'),
});

export type HistoricalSaleRowInput = z.infer<typeof historicalSaleRowSchema>;

export const historicalSalesPreviewSchema = z.object({
  rows: z.array(historicalSaleRowSchema).min(1, 'Danh sách dữ liệu bán hàng không được rỗng').max(5000, 'Tối đa 5,000 dòng mỗi lần import'),
});

export const historicalSalesCommitSchema = z.object({
  jobId: z.string().uuid('Mã Job không hợp lệ'),
});

export const historicalSalesListQuerySchema = z.object({
  sku: z.string().optional(),
  stockItemId: z.coerce.number().int().optional(),
  source: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
