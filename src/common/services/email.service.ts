import nodemailer from 'nodemailer';
import { logger } from '../logger';

export interface SendOtpEmailParams {
  to: string;
  name?: string;
  otp: string;
  expiresMinutes?: number;
}

/**
 * Tạo HTML template cho email gửi OTP đăng ký tài khoản StockPilot
 */
function createRegisterOtpEmailTemplate({ name, otp, expiresMinutes = 10 }: { name?: string; otp: string; expiresMinutes?: number }): string {
  const greeting = name ? `Xin chào <strong>${name}</strong>,` : 'Xin chào bạn,';

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mã OTP xác thực đăng ký tài khoản StockPilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); padding: 36px 32px 30px; text-align: center; color: #ffffff; }
    .logo-badge { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 12px; padding: 8px 16px; font-size: 13px; font-weight: 700; letter-spacing: 1px; margin-bottom: 12px; backdrop-filter: blur(4px); }
    .title { font-size: 24px; font-weight: 800; margin: 0; line-height: 1.3; }
    .content { padding: 36px 32px; }
    .greeting { font-size: 16px; margin-bottom: 16px; color: #334155; }
    .desc { font-size: 14px; line-height: 1.6; color: #64748b; margin-bottom: 24px; }
    .otp-box { background: #eff6ff; border: 2px dashed #60a5fa; border-radius: 16px; padding: 24px; text-align: center; margin: 24px 0; }
    .otp-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #2563eb; margin-bottom: 8px; }
    .otp-code { font-size: 38px; font-weight: 900; letter-spacing: 8px; color: #1d4ed8; font-family: 'Courier New', Courier, monospace; margin: 0; }
    .otp-exp { font-size: 12px; color: #64748b; margin-top: 10px; }
    .warning { background: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #b45309; line-height: 1.5; margin-bottom: 24px; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 24px 32px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-badge">STOCKPILOT VIETNAM</div>
      <h1 class="title">Xác thực Đăng ký Tài khoản</h1>
    </div>
    <div class="content">
      <p class="greeting">${greeting}</p>
      <p class="desc">
        Cảm ơn bạn đã lựa chọn đăng ký tài khoản tại <strong>StockPilot</strong>. Để kích hoạt tài khoản của bạn, vui lòng nhập mã xác thực OTP 6 chữ số dưới đây:
      </p>
      
      <div class="otp-box">
        <div class="otp-label">MÃ XÁC THỰC ĐĂNG KÝ</div>
        <p class="otp-code">${otp}</p>
        <p class="otp-exp">Mã có hiệu lực trong <strong>${expiresMinutes} phút</strong></p>
      </div>

      <div class="warning">
        ⚠️ <strong>Lưu ý bảo mật:</strong> Không cung cấp mã OTP này cho người khác. Nếu bạn không thực hiện đăng ký tài khoản tại StockPilot, vui lòng bỏ qua email này.
      </div>
    </div>
    <div class="footer">
      StockPilot • Nền tảng quản lý tồn kho và hỗ trợ quyết định thông minh<br>
      Đây là email tự động, vui lòng không trả lời trực tiếp.
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Gửi email chứa mã OTP đăng ký tài khoản qua Gmail / SMTP
 */
export async function sendRegisterOtpEmail({ to, name, otp, expiresMinutes = 10 }: SendOtpEmailParams): Promise<{ sent: boolean; simulated?: boolean }> {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '';
  const from = process.env.EMAIL_FROM || (user ? `"StockPilot" <${user}>` : '"StockPilot Vietnam" <no-reply@stockpilot.vn>');

  if (!user || !pass) {
    logger.info(`[Email Service - Giả lập SMTP] Không có SMTP_USER/SMTP_PASS, hiển thị mã OTP đăng ký ra console:`);
    console.log('\n======================================================');
    console.log(`📩 [STOCKPILOT REGISTER OTP GMAIL SERVICE]`);
    console.log(`   Đến:     ${to}`);
    console.log(`   Mã OTP:  >>> ${otp} <<<`);
    console.log(`   Hết hạn: ${expiresMinutes} phút`);
    console.log('======================================================\n');
    return { sent: false, simulated: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    });

    await transporter.sendMail({
      from,
      to,
      subject: `[StockPilot] Mã OTP xác thực đăng ký tài khoản: ${otp}`,
      text: `Mã OTP xác thực đăng ký tài khoản StockPilot của bạn là: ${otp}. Mã có hiệu lực trong ${expiresMinutes} phút.`,
      html: createRegisterOtpEmailTemplate({ name, otp, expiresMinutes }),
    });

    logger.info(`[Email Service] Đã gửi mã OTP đăng ký thành công tới Gmail: ${to}`);
    return { sent: true };
  } catch (err: any) {
    logger.error(`[Email Service] Gửi email đăng ký qua SMTP thất bại: ${err?.message || err}`);
    console.log('\n======================================================');
    console.log(`⚠️ Gửi SMTP thất bại, mã OTP dự phòng:`);
    console.log(`   Đến:     ${to}`);
    console.log(`   Mã OTP:  >>> ${otp} <<<`);
    console.log('======================================================\n');
    return { sent: false, simulated: true };
  }
}

/**
 * Tạo HTML template cho email gửi OTP đặt lại mật khẩu của StockPilot
 */
function createOtpEmailTemplate({ name, otp, expiresMinutes = 15 }: { name?: string; otp: string; expiresMinutes?: number }): string {
  const greeting = name ? `Xin chào <strong>${name}</strong>,` : 'Xin chào bạn,';

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mã OTP đặt lại mật khẩu StockPilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); padding: 36px 32px 30px; text-align: center; color: #ffffff; }
    .logo-badge { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 12px; padding: 8px 16px; font-size: 13px; font-weight: 700; letter-spacing: 1px; margin-bottom: 12px; backdrop-filter: blur(4px); }
    .title { font-size: 24px; font-weight: 800; margin: 0; line-height: 1.3; }
    .content { padding: 36px 32px; }
    .greeting { font-size: 16px; margin-bottom: 16px; color: #334155; }
    .desc { font-size: 14px; line-height: 1.6; color: #64748b; margin-bottom: 24px; }
    .otp-box { background: #f8fafc; border: 2px dashed #93c5fd; border-radius: 16px; padding: 24px; text-align: center; margin: 24px 0; }
    .otp-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #2563eb; margin-bottom: 8px; }
    .otp-code { font-size: 38px; font-weight: 900; letter-spacing: 8px; color: #1e3a8a; font-family: 'Courier New', Courier, monospace; margin: 0; }
    .otp-exp { font-size: 12px; color: #64748b; margin-top: 10px; }
    .warning { background: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #b45309; line-height: 1.5; margin-bottom: 24px; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 24px 32px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-badge">STOCKPILOT VIETNAM</div>
      <h1 class="title">Xác thực Đặt lại Mật khẩu</h1>
    </div>
    <div class="content">
      <p class="greeting">${greeting}</p>
      <p class="desc">
        Hệ thống StockPilot nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với địa chỉ Gmail này. Dưới đây là mã xác thực OTP dùng một lần của bạn:
      </p>
      
      <div class="otp-box">
        <div class="otp-label">MÃ XÁC THỰC OTP</div>
        <p class="otp-code">${otp}</p>
        <p class="otp-exp">Mã có hiệu lực trong <strong>${expiresMinutes} phút</strong></p>
      </div>

      <div class="warning">
        ⚠️ <strong>Cảnh báo bảo mật:</strong> Tuyệt đối không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên hỗ trợ của StockPilot. Nếu bạn không yêu cầu đổi mật khẩu, vui lòng bỏ qua email này.
      </div>
    </div>
    <div class="footer">
      StockPilot • Nền tảng quản lý tồn kho và hỗ trợ quyết định thông minh<br>
      Đây là email tự động, vui lòng không trả lời trực tiếp.
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Gửi email chứa mã OTP đặt lại mật khẩu qua Gmail / SMTP
 */
export async function sendPasswordResetOtpEmail({ to, name, otp, expiresMinutes = 15 }: SendOtpEmailParams): Promise<{ sent: boolean; simulated?: boolean }> {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '';
  const from = process.env.EMAIL_FROM || (user ? `"StockPilot" <${user}>` : '"StockPilot Vietnam" <no-reply@stockpilot.vn>');

  // Nếu chưa cấu hình tài khoản SMTP, ghi log nổi bật ra terminal để tiện test
  if (!user || !pass) {
    logger.info(`[Email Service - Giả lập SMTP] Không có SMTP_USER/SMTP_PASS, hiển thị mã OTP ra console:`);
    console.log('\n======================================================');
    console.log(`📩 [STOCKPILOT OTP GMAIL SERVICE]`);
    console.log(`   Đến:     ${to}`);
    console.log(`   Mã OTP:  >>> ${otp} <<<`);
    console.log(`   Hết hạn: ${expiresMinutes} phút`);
    console.log('======================================================\n');
    return { sent: false, simulated: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    });

    await transporter.sendMail({
      from,
      to,
      subject: `[StockPilot] Mã OTP xác nhận đặt lại mật khẩu: ${otp}`,
      text: `Mã OTP xác thực đặt lại mật khẩu StockPilot của bạn là: ${otp}. Mã có hiệu lực trong ${expiresMinutes} phút. Tuyệt đối không chia sẻ mã này cho người khác.`,
      html: createOtpEmailTemplate({ name, otp, expiresMinutes }),
    });

    logger.info(`[Email Service] Đã gửi mã OTP thành công tới Gmail: ${to}`);
    return { sent: true };
  } catch (err: any) {
    logger.error(`[Email Service] Gửi email qua SMTP thất bại: ${err?.message || err}`);
    console.log('\n======================================================');
    console.log(`⚠️ Gửi SMTP thất bại, mã OTP dự phòng:`);
    console.log(`   Đến:     ${to}`);
    console.log(`   Mã OTP:  >>> ${otp} <<<`);
    console.log('======================================================\n');
    return { sent: false, simulated: true };
  }
}
