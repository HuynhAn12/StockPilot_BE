import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError());
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Tài khoản không đủ quyền để truy cập tài nguyên này'));
    }

    next();
  };
}

export function requireStoreScope(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthenticatedError());
  }

  if (req.user.role !== 'ADMIN' && !req.user.storeId) {
    return next(new ForbiddenError('Người dùng chưa được liên kết với bất kỳ cửa hàng nào'));
  }

  next();
}
