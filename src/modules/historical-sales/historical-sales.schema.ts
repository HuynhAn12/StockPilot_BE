import { z } from 'zod';

const optionalHistoricalCostSchema = z.preprocess((value) => {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return undefined;
  }
  return value;
}, z.coerce.number().min(0, 'Giá vốn không được âm').optional());

export const historicalSaleRowSchema = z
  .object({
    externalOrderId: z.string().trim().max(100).optional().nullable(),
    sku: z.string().trim().min(1, 'SKU không được để trống').max(100),
    quantity: z.coerce.number().int('Số lượng phải là số nguyên').positive('Số lượng bán phải lớn hơn 0'),
    unitPrice: z.coerce.number().min(0, 'Đơn giá không được âm'),
    costPrice: optionalHistoricalCostSchema,
    unitCost: optionalHistoricalCostSchema,
    soldAt: z.coerce.date({ errorMap: () => ({ message: 'Ngày bán soldAt không hợp lệ' }) }),
    source: z.string().trim().min(1).max(50).default('CSV'),
  })
  .superRefine((row, ctx) => {
    if (row.costPrice !== undefined && row.unitCost !== undefined) {
      const costPrice = Number(row.costPrice);
      const unitCost = Number(row.unitCost);
      if (costPrice !== unitCost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['costPrice'],
          message: 'costPrice and unitCost must match when both are provided',
        });
      }
    }
  })
  .transform(({ costPrice, unitCost, ...row }) => {
    const resolved = costPrice !== undefined ? costPrice : (unitCost !== undefined ? unitCost : null);
    return {
      ...row,
      costPriceSnapshot: resolved !== null ? Number(resolved) : null,
    };
  });

export type HistoricalSaleRowInput = z.infer<typeof historicalSaleRowSchema>;

export const historicalSalesPreviewSchema = z.object({
  rows: z.array(historicalSaleRowSchema).min(1, 'Danh sách dữ liệu bán hàng không được rỗng').max(5000, 'Tối đa 5,000 dòng mỗi lần import'),
});

export type HistoricalSalesPreviewInput = z.infer<typeof historicalSalesPreviewSchema>;

export const historicalSalesCommitSchema = z.object({
  jobId: z.string().uuid('Mã Job không hợp lệ'),
});

export type HistoricalSalesCommitInput = z.infer<typeof historicalSalesCommitSchema>;

export const historicalSalesListQuerySchema = z.object({
  sku: z.string().optional(),
  stockItemId: z.coerce.number().int().optional(),
  source: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type HistoricalSalesListQueryInput = z.infer<typeof historicalSalesListQuerySchema>;
