import { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';
import { HttpMetricsService } from '../services/http-metrics.service';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const user = (req as any).user;
    const requestId = (req as any).requestId || req.headers['x-request-id'];
    const latencyMs = Number(elapsedMs.toFixed(2));

    HttpMetricsService.record({ method: req.method, path: req.path, statusCode: res.statusCode, latencyMs, requestId: typeof requestId === 'string' ? requestId : undefined });

    logger.info('http_request_completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs,
      userId: user?.id,
      storeId: user?.storeId,
    });
  });

  next();
}
