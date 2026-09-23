import { Request, Response, NextFunction } from 'express';
import { UserService } from './user.service';

const userService = new UserService();

export class UserController {
  async createStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const staff = await userService.createStaff(storeId, req.body);
      return res.status(201).json({
        success: true,
        message: 'Tạo tài khoản nhân viên kho thành công',
        data: staff,
      });
    } catch (error) {
      next(error);
    }
  }

  async listStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const users = await userService.listStoreUsers(storeId);
      return res.status(200).json({
        success: true,
        data: users,
      });
    } catch (error) {
      next(error);
    }
  }
}
