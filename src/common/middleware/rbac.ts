import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';
import { env } from '../../config/env';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError());
    }

    // ADMIN has full system-level access to inspect operations or if explicitly in allowed roles
    if (roles.includes(req.user.role) || req.user.role === 'ADMIN') {
      return next();
    }

    return next(new ForbiddenError('Tài khoản không có quyền thực hiện thao tác này'));
  };
}

export function requireStoreScope(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthenticatedError());
  }

  // Admin can access any store scope or global endpoints
  if (req.user.role === 'ADMIN') {
    if (!req.user.storeId) {
      const targetStoreId = req.query.storeId || req.headers['x-store-id'] || req.tenant?.storeId;
      if (targetStoreId) {
        req.user.storeId = Number(targetStoreId);
      }
    }
    return next();
  }

  if (!req.user.storeId) {
    return next(new ForbiddenError('Account is not linked to a store'));
  }

  if (env.NODE_ENV === 'production' && !req.tenant) {
    return next(new ForbiddenError('Store tenant hostname is required for shop APIs'));
  }

  if (req.tenant && req.tenant.storeId !== req.user.storeId) {
    return next(new ForbiddenError('Authenticated user does not belong to the requested store tenant'));
  }

  return next();
}
