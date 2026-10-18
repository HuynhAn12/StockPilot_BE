import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';
import { env } from '../../config/env';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError());
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Account does not have permission for this operation'));
    }

    return next();
  };
}

export function requireStoreScope(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthenticatedError());
  }

  if (req.user.role === 'ADMIN') {
    return next(new ForbiddenError('Admin must use dedicated admin endpoints and cannot select a store for shop APIs'));
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
