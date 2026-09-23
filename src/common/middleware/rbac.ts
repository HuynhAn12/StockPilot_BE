import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

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

  return next();
}
