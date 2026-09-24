import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error';
import { env } from '../../config/env';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'unknown';

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    });
  }

  if ((err as any).code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'Unique constraint conflict',
        requestId,
      },
    });
  }

  if ((err as any).code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Requested record was not found',
        requestId,
      },
    });
  }

  // Log unexpected errors
  console.error('[UNHANDLED_ERROR]', {
    requestId,
    message: err.message,
    stack: err.stack,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Đã xảy ra lỗi máy chủ nội bộ. Vui lòng thử lại sau.',
      requestId,
      ...(env.NODE_ENV === 'development' ? { debug: err.message } : {}),
    },
  });
}
