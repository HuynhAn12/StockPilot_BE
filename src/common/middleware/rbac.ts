import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError());
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Tài khoản không đủ quyền để thực hiện thao tác này'));
    }

    next();
  };
}

export function requireStoreScope(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthenticatedError());
  }

  // If ADMIN accesses a store resource, allow passing target storeId via header or query
  if (req.user.role === 'ADMIN') {
    const storeIdQuery = req.query.storeId ? Number(req.query.storeId) : undefined;
    const storeIdHeader = req.headers['x-store-id'] ? Number(req.headers['x-store-id']) : undefined;

    if (!req.user.storeId && (storeIdQuery || storeIdHeader)) {
      req.user.storeId = storeIdQuery || storeIdHeader || null;
    }
  }

  if (!req.user.storeId) {
    return next(new ForbiddenError('Người dùng chưa được liên kết với bất kỳ cửa hàng nào'));
  }

  next();
}
