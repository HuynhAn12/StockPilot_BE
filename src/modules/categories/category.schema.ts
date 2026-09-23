import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Tên danh mục không được để trống'),
  code: z.string().min(1, 'Mã danh mục không được để trống').regex(/^[A-Za-z0-9_-]+$/, 'Mã danh mục chỉ chứa ký tự chữ cái, số, gạch nối hoặc gạch dưới'),
  description: z.string().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});
