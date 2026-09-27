import { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const user = (req as any).user;

    logger.info('http_request_completed', {
      requestId: (req as any).requestId || req.headers['x-request-id'],
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs: Number(elapsedMs.toFixed(2)),
      userId: user?.id,
      storeId: user?.storeId,
    });
  });

  next();
}
