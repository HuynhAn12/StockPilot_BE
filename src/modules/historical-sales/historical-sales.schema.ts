import { z } from 'zod';

const optionalCostSchema = z.coerce.number().min(0, 'Gia von khong duoc am').optional().nullable();

export const historicalSaleRowSchema = z
  .object({
    externalOrderId: z.string().trim().max(100).optional().nullable(),
    sku: z.string().trim().min(1, 'SKU khong duoc de trong').max(100),
    quantity: z.coerce.number().int('So luong phai la so nguyen').positive('So luong ban phai lon hon 0'),
    unitPrice: z.coerce.number().min(0, 'Don gia khong duoc am'),
    costPrice: optionalCostSchema,
    unitCost: optionalCostSchema,
    soldAt: z.coerce.date({ errorMap: () => ({ message: 'Ngay ban soldAt khong hop le' }) }),
    source: z.string().trim().min(1).max(50).default('CSV'),
  })
  .superRefine((row, ctx) => {
    if (row.costPrice !== null && row.costPrice !== undefined && row.unitCost !== null && row.unitCost !== undefined) {
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
  .transform(({ costPrice, unitCost, ...row }) => ({
    ...row,
    costPriceSnapshot: costPrice ?? unitCost ?? null,
  }));

export type HistoricalSaleRowInput = z.infer<typeof historicalSaleRowSchema>;

export const historicalSalesPreviewSchema = z.object({
  rows: z.array(historicalSaleRowSchema).min(1, 'Danh sach du lieu ban hang khong duoc rong').max(5000, 'Toi da 5,000 dong moi lan import'),
});

export const historicalSalesCommitSchema = z.object({
  jobId: z.string().uuid('Ma Job khong hop le'),
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
