import { z } from 'zod';

const stockItemInputSchema = z.object({
  sku: z.string().min(1, 'SKU không được để trống'),
  name: z.string().min(1, 'Tên biến thể không được để trống'),
  barcode: z.string().optional(),
  costPrice: z.coerce.number().min(0, 'Giá vốn không được âm'),
  sellingPrice: z.coerce.number().min(0, 'Giá bán không được âm'),
  minStockLevel: z.coerce.number().int().min(0).default(0),
  maxStockLevel: z.coerce.number().int().min(0).default(1000),
}).superRefine((item, ctx) => {
  if (item.minStockLevel > item.maxStockLevel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minStockLevel'],
      message: 'minStockLevel must be less than or equal to maxStockLevel',
    });
  }
});

export const createProductSchema = z.object({
  categoryId: z.number().int().optional(),
  name: z.string().min(1, 'Tên sản phẩm không được để trống'),
  code: z.string().min(1, 'Mã sản phẩm không được để trống').regex(/^[A-Za-z0-9_-]+$/, 'Mã sản phẩm chỉ chứa ký tự chữ cái, số, gạch nối hoặc gạch dưới'),
  description: z.string().optional(),
  items: z.array(stockItemInputSchema).min(1, 'Sản phẩm phải có ít nhất 1 SKU/biến thể'),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    const normalizedSku = item.sku.trim().toUpperCase();
    if (seen.has(normalizedSku)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'sku'],
        message: 'Duplicate SKU in the same request',
      });
    }
    seen.add(normalizedSku);
  });
});

export const updateProductSchema = z.object({
  categoryId: z.number().int().nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});
