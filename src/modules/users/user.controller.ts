import { Request, Response, NextFunction } from 'express';
import { UserService } from './user.service';

const userService = new UserService();

export class UserController {
  async createStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const user = await userService.createStaff(storeId, req.body, req.user!.userId);
      return res.status(201).json({
        success: true,
        message: 'Tạo tài khoản nhân viên thành công',
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async listStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const query = (req as any).validatedQuery || req.query;
      const result = await userService.listStoreUsers(storeId, query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const staffId = Number(req.params.id);
      const user = await userService.updateStaff(storeId, staffId, req.body, req.user!.userId);
      return res.status(200).json({
        success: true,
        message: 'Cap nhat nhan vien thanh cong',
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }
}
