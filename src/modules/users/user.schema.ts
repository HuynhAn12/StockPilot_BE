import { z } from 'zod';

export const createStaffSchema = z.object({
  fullName: z.string().min(2, 'Họ tên phải có ít nhất 2 ký tự'),
  email: z.string().email('Email không đúng định dạng'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự'),
});

export const updateStaffSchema = z.object({
  fullName: z.string().min(2, 'Ho ten phai co it nhat 2 ky tu').optional(),
  isActive: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: 'At least one staff field is required',
});
