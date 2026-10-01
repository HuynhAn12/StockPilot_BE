import { z } from 'zod';
import { isValidTenantCode, normalizeTenantCode } from '../../common/utils/tenant-slug';

export const registerSchema = z.object({
  fullName: z.string().min(2, 'Họ tên phải có ít nhất 2 ký tự'),
  email: z.string().email('Email không đúng định dạng'),
  password: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự'),
  storeName: z.string().min(2, 'Tên cửa hàng phải có ít nhất 2 ký tự'),
  storeCode: z
    .string()
    .min(2, 'Mã cửa hàng phải có ít nhất 2 ký tự')
    .max(50, 'Mã cửa hàng không được vượt quá 50 ký tự')
    .transform(normalizeTenantCode)
    .refine(isValidTenantCode, {
      message:
        'Mã cửa hàng phải là slug DNS hợp lệ: chữ cái thường, số hoặc dấu gạch ngang, không bắt đầu/kết thúc bằng dấu gạch ngang và không dùng tên hệ thống',
    }),
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
