import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError } from '../errors/app-error';

export interface IdempotencyOptions {
  operation: string;
  ttlSeconds?: number;
}

export function canonicalJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}';
}

/**
 * Request-Level Idempotency Middleware (V7 Hardened)
 * - P0-01: Canonical Request Identity includes Method + Path + Params + Query + Body
 * - P0-02: Stale & Expired PROCESSING automatic cleanup & eviction
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
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const canonicalRequestString = [
      req.method.toUpperCase(),
      (req.baseUrl || '') + (req.path || ''),
      canonicalJsonStringify(req.params || {}),
      canonicalJsonStringify(req.query || {}),
      canonicalJsonStringify(req.body || {}),
    ].join('|');

    const requestHash = crypto
      .createHash('sha256')
      .update(canonicalRequestString)
      .digest('hex');

    const prisma = req.app.get('prisma') || defaultPrisma;

    try {
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
        const isExpired = existing.expiresAt <= now;
        const isStaleProcessing =
          existing.status === 'PROCESSING' &&
          existing.createdAt < new Date(now.getTime() - 60000);

        if (isExpired || isStaleProcessing || existing.status === 'FAILED') {
          // Evict stale/failed record to allow clean execution
          await prisma.idempotencyRequest.delete({ where: { id: existing.id } }).catch(() => {});
        } else {
          // Payload tampering detection
          if (existing.requestHash !== requestHash) {
            throw new ConflictError('IDEMPOTENCY_KEY_REUSED: Khóa Idempotency-Key đã được sử dụng với payload hoặc endpoint khác');
          }

          // Return saved response if already completed
          if (existing.status === 'COMPLETED' && existing.responseJson) {
            res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_HIT');
            return res.status(existing.statusCode || 200).json(existing.responseJson);
          }

          // Return in-progress conflict if currently active
          if (existing.status === 'PROCESSING') {
            throw new ConflictError('REQUEST_IN_PROGRESS: Yêu cầu với Idempotency-Key này đang được xử lý');
          }
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
