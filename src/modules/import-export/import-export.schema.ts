import { z } from 'zod';

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
  minStockLevel: z.coerce.number().int().min(0).default(0),
  maxStockLevel: z.coerce.number().int().min(0).default(1000),
});

export const importPreviewSchema = z.object({
  items: z.array(importItemSchema).min(1, 'Danh sách import phải có ít nhất 1 dòng'),
});

export const importCommitSchema = z.object({
  items: z.array(importItemSchema).min(1, 'Danh sách import phải có ít nhất 1 dòng'),
  warehouseId: z.coerce.number().int().positive().optional(),
});
