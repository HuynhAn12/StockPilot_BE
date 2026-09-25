import { z } from 'zod';

export const importModeSchema = z.enum([
  'CREATE_ONLY',
  'UPSERT_METADATA',
  'ADJUST_STOCK',
  'REPLACE_STOCK',
]);

export type ImportMode = z.infer<typeof importModeSchema>;

export const importItemSchema = z.object({
  categoryName: z.string().min(1, 'Tên danh mục không được để trống'),
  categoryCode: z.string().min(1, 'Mã danh mục không được để trống'),
  productName: z.string().min(1, 'Tên sản phẩm không được để trống'),
  productCode: z.string().min(1, 'Mã sản phẩm không được để trống'),
  sku: z.string().min(1, 'Mã SKU không được để trống'),
  barcode: z.string().optional(),
  costPrice: z.coerce.number().min(0, 'Giá vốn phải lớn hơn hoặc bằng 0').default(0),
  sellingPrice: z.coerce.number().min(0, 'Giá bán phải lớn hơn hoặc bằng 0').default(0),
  initialQuantity: z.coerce.number().int().min(0, 'Số lượng tồn đầu kỳ phải lớn hơn hoặc bằng 0').default(0),
  stockAdjustment: z.coerce.number().int().optional(),
  countedQuantity: z.coerce.number().int().min(0, 'Số lượng kiểm kê phải >= 0').optional(),
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

export const importPreviewSchema = z.object({
  items: z.array(importItemSchema).min(1, 'Danh sách import phải có ít nhất 1 dòng'),
  mode: importModeSchema.optional().default('CREATE_ONLY'),
  warehouseId: z.coerce.number().int().positive().optional(),
}).superRefine((input, ctx) => {
  input.items.forEach((item, index) => {
    if (input.mode === 'UPSERT_METADATA') {
      if (item.initialQuantity > 0 || item.stockAdjustment !== undefined || item.countedQuantity !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'UPSERT_METADATA cannot include inventory mutation fields',
        });
      }
    }

    if (input.mode === 'ADJUST_STOCK') {
      if (item.stockAdjustment === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'stockAdjustment'],
          message: 'ADJUST_STOCK requires stockAdjustment',
        });
      }
      if (item.countedQuantity !== undefined || item.initialQuantity > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'ADJUST_STOCK cannot use initialQuantity or countedQuantity',
        });
      }
    }

    if (input.mode === 'REPLACE_STOCK') {
      if (item.countedQuantity === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'countedQuantity'],
          message: 'REPLACE_STOCK requires countedQuantity',
        });
      }
      if (item.stockAdjustment !== undefined || item.initialQuantity > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'REPLACE_STOCK cannot use initialQuantity or stockAdjustment',
        });
      }
    }
  });
});

export const importCommitSchema = z.object({
  jobId: z.string().min(1, 'Mã jobId của bản xem trước (preview) là bắt buộc để commit an toàn'),
});
