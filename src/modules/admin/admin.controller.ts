import { Request, Response, NextFunction } from 'express';
import { AdminService, RequestMeta } from './admin.service';

const adminService = new AdminService();

function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
  };
}

export class AdminController {
  async getDashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getDashboard();
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async listUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.listUsers(req.query as any);
      return res.status(200).json({ success: true, data: result.items, pagination: result.pagination });
    } catch (error) {
      next(error);
    }
  }

  async getUser(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getUserDetail(Number(req.params.id));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async createAdminUser(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.createAdminUser(req.body, req.user!.userId, requestMeta(req));
      return res.status(201).json({ success: true, message: 'Tạo tài khoản quản trị viên thành công', data });
    } catch (error) {
      next(error);
    }
  }

  async updateUserStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.updateUserStatus(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      return res.status(200).json({
        success: true,
        message: data.isActive ? 'Đã mở khóa tài khoản' : 'Đã khóa tài khoản và thu hồi toàn bộ phiên đăng nhập',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  async listStores(req: Request, res: Response, next: NextFunction) {
    try {
      const [result, summary] = await Promise.all([adminService.listStores(req.query as any), adminService.getStoreSummary()]);
      return res.status(200).json({ success: true, data: result.items, pagination: result.pagination, summary });
    } catch (error) {
      next(error);
    }
  }

  async getStore(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getStoreDetail(Number(req.params.id));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async updateStoreStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.updateStoreStatus(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      return res.status(200).json({
        success: true,
        message: data.isActive ? 'Đã mở lại cửa hàng' : 'Đã tạm khóa cửa hàng và đăng xuất toàn bộ người dùng của cửa hàng',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  async listAuditLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.listAuditLogs(req.query as any);
      return res.status(200).json({ success: true, data: result.items, pagination: result.pagination });
    } catch (error) {
      next(error);
    }
  }

  async exportAuditLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const csv = await adminService.exportAuditLogsCsv(req.query as any, req.user!.userId, requestMeta(req));
      const fileName = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async getAiUsage(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getAiUsage(req.query as any);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async updateUserProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.updateUserProfile(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async updateStore(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.updateStore(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async revokeUserSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.revokeUserSessions(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async sendPasswordReset(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.sendPasswordReset(Number(req.params.id), req.user!.userId, requestMeta(req));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSystemSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getSystemSettings();
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async updateSystemSetting(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.updateSystemSetting(req.params.key as any, req.body.value, req.user!.userId, requestMeta(req));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSystemHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getSystemHealth();
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getConfigStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getConfigStatus();
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

}
