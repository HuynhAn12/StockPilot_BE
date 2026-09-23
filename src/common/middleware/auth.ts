import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { UnauthenticatedError } from '../errors/app-error';
import { prisma } from '../../config/db';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      requestId?: string;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthenticatedError('Missing or invalid Authorization Bearer token'));
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        role: true,
        storeId: true,
        isActive: true,
        store: {
          select: { isActive: true },
        },
      },
    });

    if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
      return next(new UnauthenticatedError('Account is inactive or no longer valid'));
    }

    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
    };
    return next();
  } catch {
    return next(new UnauthenticatedError('Invalid or expired token'));
  }
}
