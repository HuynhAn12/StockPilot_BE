import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  async sendRegisterOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.authService.sendRegisterOtp(req.body);
      return res.status(200).json({
        success: true,
        message: 'Mã xác thực OTP đã được gửi đến email đăng ký của bạn.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const meta = {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.socket.remoteAddress,
      };
      const result = await this.authService.registerOwner(req.body, meta);
      return res.status(201).json({
        success: true,
        message: 'Đăng ký tài khoản Shop Owner thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const meta = {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.socket.remoteAddress,
      };
      const result = await this.authService.login(req.body, meta);
      return res.status(200).json({
        success: true,
        message: 'Đăng nhập thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const meta = {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.socket.remoteAddress,
      };
      const result = await this.authService.refreshToken(req.body.refreshToken, meta);
      return res.status(200).json({
        success: true,
        message: 'Làm mới token thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const refreshToken = req.body.refreshToken;
      await this.authService.logout(userId, refreshToken);
      return res.status(200).json({
        success: true,
        message: 'Đăng xuất thành công',
      });
    } catch (error) {
      next(error);
    }
  }

  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const user = await this.authService.getMe(userId);
      return res.status(200).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const user = await this.authService.updateMe(userId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Cap nhat ho so thanh cong',
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.authService.forgotPassword(req.body);
      const data = process.env.NODE_ENV === 'production'
        ? { expiresAt: result.expiresAt }
        : result;

      return res.status(200).json({
        success: true,
        message: req.body.phone
          ? 'Mã xác thực OTP đã được gửi đến số điện thoại của bạn.'
          : 'Mã xác thực OTP đã được gửi đến địa chỉ email của bạn.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  async verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.authService.verifyOtp(req.body);
      return res.status(200).json({
        success: true,
        message: 'Mã OTP chính xác. Vui lòng thiết lập mật khẩu mới.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      await this.authService.resetPassword(req.body);
      return res.status(200).json({
        success: true,
        message: 'Password has been reset successfully.',
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStore(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await this.authService.updateStore(userId, req.body);
      return res.status(200).json({
        success: true,
        message: 'Cập nhật thông tin cửa hàng thành công',
        data: result.store,
      });
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await this.authService.changePassword(userId, req.body);
      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }
}

