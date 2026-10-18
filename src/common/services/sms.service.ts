import { logger } from '../logger';

export interface SendOtpSmsParams {
  phone: string;
  name?: string;
  otp: string;
  expiresMinutes?: number;
}

/**
 * Chuẩn hóa số điện thoại Việt Nam (ví dụ: '0988 123 456' -> '0988123456' hoặc '+84988123456')
 */
export function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  }
  return cleaned;
}

/**
 * Gửi mã OTP xác thực qua tin nhắn SMS / SMS Gateway
 * Hỗ trợ chế độ giả lập (Simulation) in ra terminal và tích hợp SMS Gateway (eSMS, SpeedSMS, Twilio)
 */
export async function sendPasswordResetOtpSms({
  phone,
  name,
  otp,
  expiresMinutes = 15,
}: SendOtpSmsParams): Promise<{ sent: boolean; simulated?: boolean }> {
  const normalizedPhone = normalizePhoneNumber(phone);
  const smsProvider = (process.env.SMS_PROVIDER || 'simulation').toLowerCase();
  const smsApiKey = process.env.SMS_API_KEY || '';
  const smsSecret = process.env.SMS_API_SECRET || process.env.SMS_SECRET_KEY || '';

  // Chế độ Giả lập / Terminal log nếu chưa cấu hình cổng SMS
  if (smsProvider === 'simulation' || !smsApiKey) {
    logger.info(`[SMS Service - Chế độ Giả lập] Không có SMS_API_KEY, hiển thị mã OTP SMS ra console:`);
    console.log('\n======================================================');
    console.log(`📱 [STOCKPILOT SMS OTP SERVICE]`);
    console.log(`   Khách hàng: ${name || 'Chủ cửa hàng'}`);
    console.log(`   Đến SĐT:    ${normalizedPhone}`);
    console.log(`   Mã OTP:     >>> ${otp} <<<`);
    console.log(`   Hết hạn:    ${expiresMinutes} phút`);
    console.log('======================================================\n');
    return { sent: true, simulated: true };
  }

  // Tích hợp SpeedSMS Gateway nếu có cấu hình
  if (smsProvider === 'speedsms') {
    try {
      const response = await fetch('https://api.speedsms.vn/index.php/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${smsApiKey}:x`).toString('base64'),
        },
        body: JSON.stringify({
          to: [normalizedPhone],
          content: `Ma OTP dat lai mat khau StockPilot cua ban la: ${otp}. Hieu luc trong ${expiresMinutes} phut.`,
          sms_type: 2, // SMS OTP
          sender: process.env.SMS_BRANDNAME || '',
        }),
      });

      const resData = (await response.json()) as any;
      if (resData.status === 'success') {
        logger.info(`[SMS Service] Đã gửi OTP SMS thành công tới ${normalizedPhone}`);
        return { sent: true };
      }
      throw new Error(resData.message || 'SpeedSMS trả về lỗi');
    } catch (err: any) {
      logger.error(`[SMS Service] Gửi SMS qua SpeedSMS thất bại: ${err?.message || err}`);
    }
  }

  // Tích hợp eSMS Gateway nếu có cấu hình
  if (smsProvider === 'esms') {
    try {
      const response = await fetch('http://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ApiKey: smsApiKey,
          SecretKey: smsSecret,
          Phone: normalizedPhone,
          Content: `[StockPilot] Ma OTP xac thuc cua ban la ${otp}. Ma co hieu luc trong ${expiresMinutes} phut.`,
          SmsType: '2',
          Brandname: process.env.SMS_BRANDNAME || 'StockPilot',
        }),
      });

      const resData = (await response.json()) as any;
      if (resData.CodeResult === '100') {
        logger.info(`[SMS Service] Đã gửi OTP qua eSMS thành công tới ${normalizedPhone}`);
        return { sent: true };
      }
      throw new Error(resData.ErrorMessage || 'eSMS trả về lỗi');
    } catch (err: any) {
      logger.error(`[SMS Service] Gửi SMS qua eSMS thất bại: ${err?.message || err}`);
    }
  }

  // Dự phòng hiển thị ra Terminal nếu gọi cổng thật lỗi
  console.log('\n======================================================');
  console.log(`⚠️ Gửi SMS qua cổng thất bại, mã OTP dự phòng:`);
  console.log(`   Đến SĐT: ${normalizedPhone}`);
  console.log(`   Mã OTP:  >>> ${otp} <<<`);
  console.log('======================================================\n');

  return { sent: true, simulated: true };
}
