import { z } from 'zod';

export const createLeadSchema = z.object({
  fullName: z
    .string({ required_error: 'Vui lòng nhập họ và tên' })
    .trim()
    .min(2, 'Họ và tên phải có ít nhất 2 ký tự')
    .max(100, 'Họ và tên không vượt quá 100 ký tự'),
  phone: z
    .string({ required_error: 'Vui lòng nhập số điện thoại' })
    .trim()
    .min(9, 'Số điện thoại không hợp lệ')
    .max(20, 'Số điện thoại không hợp lệ')
    .regex(/^[0-9+.\s()-]+$/, 'Số điện thoại chứa ký tự không hợp lệ'),
  email: z
    .string()
    .trim()
    .email('Email không đúng định dạng')
    .optional()
    .or(z.literal('')),
  storeName: z
    .string()
    .trim()
    .max(150, 'Tên cửa hàng không vượt quá 150 ký tự')
    .optional()
    .or(z.literal('')),
  industry: z
    .string()
    .trim()
    .max(100, 'Ngành nghề không vượt quá 100 ký tự')
    .optional()
    .or(z.literal('')),
  note: z
    .string()
    .trim()
    .max(1000, 'Ghi chú không vượt quá 1000 ký tự')
    .optional()
    .or(z.literal('')),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
