import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().min(2, 'Họ tên phải có ít nhất 2 ký tự'),
  email: z.string().email('Email không đúng định dạng'),
  password: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự'),
  storeName: z.string().min(2, 'Tên cửa hàng phải có ít nhất 2 ký tự'),
  storeCode: z.string().min(2, 'Mã cửa hàng phải có ít nhất 2 ký tự').regex(/^[A-Za-z0-9_-]+$/, 'Mã cửa hàng chỉ chứa chữ cái, số, dấu gạch ngang hoặc gạch dưới'),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Email không đúng định dạng'),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token không được để trống'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().optional(),
});

export const updateProfileSchema = z.object({
  fullName: z.string().min(2, 'Ho ten phai co it nhat 2 ky tu').optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: 'At least one profile field is required',
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Email khong dung dinh dang'),
}).strict();

export const resetPasswordSchema = z.object({
  token: z.string().min(32, 'Reset token khong hop le'),
  newPassword: z.string().min(8, 'Mat khau phai co it nhat 8 ky tu'),
}).strict();
