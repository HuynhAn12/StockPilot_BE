import { z } from 'zod';
import { isValidTenantCode, normalizeTenantCode } from '../../common/utils/tenant-slug';

export const sendRegisterOtpSchema = z.object({
  fullName: z.string().min(2, 'Họ tên phải có ít nhất 2 ký tự').optional(),
  email: z.string().email('Email không đúng định dạng'),
  storeCode: z
    .string()
    .min(2, 'Mã cửa hàng phải có ít nhất 2 ký tự')
    .max(50, 'Mã cửa hàng không được vượt quá 50 ký tự')
    .transform(normalizeTenantCode)
    .refine(isValidTenantCode, {
      message:
        'Mã cửa hàng phải là slug DNS hợp lệ: chữ cái thường, số hoặc dấu gạch ngang, không bắt đầu/kết thúc bằng dấu gạch ngang và không dùng tên hệ thống',
    })
    .optional(),
});

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
  otp: z.string().min(4, 'Mã OTP không hợp lệ').max(10, 'Mã OTP không hợp lệ').optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Email không đúng định dạng'),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
  /** Mã 2FA (6 số) hoặc mã khôi phục — chỉ cần với admin đã bật xác thực 2 lớp. */
  otpCode: z.string().trim().max(20).optional(),
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
  email: z.string().email('Email không đúng định dạng').optional(),
  phone: z.string().min(9, 'Số điện thoại phải có ít nhất 9 chữ số').max(20, 'Số điện thoại không hợp lệ').optional(),
}).refine((data) => Boolean(data.email) || Boolean(data.phone), {
  message: 'Vui lòng cung cấp email hoặc số điện thoại đăng ký tài khoản',
});

export const verifyOtpSchema = z.object({
  email: z.string().email('Email không đúng định dạng').optional(),
  phone: z.string().min(9, 'Số điện thoại phải có ít nhất 9 chữ số').max(20, 'Số điện thoại không hợp lệ').optional(),
  otp: z.string().min(4, 'Mã OTP không hợp lệ').max(10, 'Mã OTP không hợp lệ'),
}).refine((data) => Boolean(data.email) || Boolean(data.phone), {
  message: 'Vui lòng cung cấp email hoặc số điện thoại cùng mã OTP',
});

export const resetPasswordSchema = z.object({
  token: z.string().min(6).optional(),
  email: z.string().email('Email không đúng định dạng').optional(),
  phone: z.string().min(9, 'Số điện thoại phải có ít nhất 9 chữ số').max(20, 'Số điện thoại không hợp lệ').optional(),
  otp: z.string().min(4).max(10).optional(),
  newPassword: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự'),
}).refine((data) => Boolean(data.token) || (Boolean(data.email || data.phone) && Boolean(data.otp)), {
  message: 'Cần cung cấp token hoặc email/số điện thoại cùng mã OTP',
});

export const updateStoreSchema = z.object({
  storeName: z.string().min(2, 'Tên cửa hàng phải có ít nhất 2 ký tự').optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Mật khẩu cũ không được để trống'),
  newPassword: z.string().min(8, 'Mật khẩu mới phải có ít nhất 8 ký tự'),
});

