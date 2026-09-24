import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError } from '../errors/app-error';

export interface IdempotencyOptions {
  operation: string;
  ttlSeconds?: number;
}

/**
 * Request-Level Idempotency Middleware (Phase 7)
 * Ensures critical commands are safely retryable without duplicate business effects.
 */
export function idempotency(options: IdempotencyOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;

    // If no Idempotency-Key header is provided, proceed normally
    if (!key) {
      return next();
    }

    const storeId = req.user?.storeId;
    if (!storeId) {
      return next();
    }

    const operation = options.operation;
    const ttlSeconds = options.ttlSeconds || 86400; // 24 hours default
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Compute deterministic SHA-256 hash of request body
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const prisma = req.app.get('prisma') || defaultPrisma;

    try {
      // 1. Check existing idempotency record
      const existing = await prisma.idempotencyRequest.findUnique({
        where: {
          storeId_operation_key: {
            storeId,
            operation,
            key,
          },
        },
      });

      if (existing) {
        // Payload tampering detection
        if (existing.requestHash !== requestHash) {
          throw new ConflictError('IDEMPOTENCY_KEY_REUSED: Khóa Idempotency-Key đã được sử dụng với payload khác');
        }

        // Return saved response if already completed
        if (existing.status === 'COMPLETED' && existing.responseJson) {
          res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_HIT');
          return res.status(existing.statusCode || 200).json(existing.responseJson);
        }

        // Return in-progress conflict if currently executing
        if (existing.status === 'PROCESSING') {
          throw new ConflictError('REQUEST_IN_PROGRESS: Yêu cầu với Idempotency-Key này đang được xử lý');
        }

        // If previously failed, delete old record to allow clean retry
        if (existing.status === 'FAILED') {
          await prisma.idempotencyRequest.delete({ where: { id: existing.id } });
        }
      }

      // 2. Reserve request as PROCESSING
      const record = await prisma.idempotencyRequest.create({
        data: {
          storeId,
          operation,
          key,
          requestHash,
          status: 'PROCESSING',
          expiresAt,
        },
      });

      // 3. Intercept response to store response payload on completion
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = (body: any) => {
        const statusCode = res.statusCode || 200;
        if (statusCode < 400) {
          prisma.idempotencyRequest
            .update({
              where: { id: record.id },
              data: {
                status: 'COMPLETED',
                statusCode,
                responseJson: body,
              },
            })
            .catch(() => {});
        } else {
          prisma.idempotencyRequest
            .update({
              where: { id: record.id },
              data: {
                status: 'FAILED',
                statusCode,
              },
            })
            .catch(() => {});
        }
        return originalJson(body);
      };

      res.send = (body: any) => {
        return originalSend(body);
      };

      next();
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Prisma unique constraint race condition
        const concurrentRecord = await prisma.idempotencyRequest.findUnique({
          where: {
            storeId_operation_key: {
              storeId,
              operation,
              key,
            },
          },
        });

        if (concurrentRecord?.status === 'COMPLETED' && concurrentRecord.responseJson) {
          return res.status(concurrentRecord.statusCode || 200).json(concurrentRecord.responseJson);
        }

        return next(new ConflictError('REQUEST_IN_PROGRESS: Yêu cầu với Idempotency-Key này đang được xử lý'));
      }
      next(err);
    }
  };
}
