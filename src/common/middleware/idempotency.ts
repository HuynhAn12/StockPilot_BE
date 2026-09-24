import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, ValidationError } from '../errors/app-error';

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

export function idempotency(options: IdempotencyOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;

    if (!key) {
      return next();
    }

    if (key.length < 1 || key.length > 128) {
      return next(new ValidationError('Idempotency-Key must be between 1 and 128 characters'));
    }

    const storeId = req.user?.storeId;
    if (!storeId) {
      return next();
    }

    const operation = options.operation;
    const ttlSeconds = options.ttlSeconds || 86400;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const identity = {
      method: req.method.toUpperCase(),
      path: (req.baseUrl || '') + (req.path || ''),
      params: req.params || {},
      query: req.query || {},
      body: req.body ?? {},
    };

    const requestHash = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(identity))
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
        if (existing.requestHash !== requestHash) {
          throw new ConflictError('IDEMPOTENCY_KEY_REUSED: Idempotency-Key was used with a different request identity');
        }

        if (existing.status === 'COMPLETED' && existing.responseJson) {
          res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_HIT');
          return res.status(existing.statusCode || 200).json(existing.responseJson);
        }

        if (existing.status === 'PROCESSING') {
          throw new ConflictError('REQUEST_IN_PROGRESS: request is processing or has an unknown outcome; it will not be replayed automatically');
        }

        if (existing.status === 'FAILED') {
          throw new ConflictError('IDEMPOTENCY_REQUEST_FAILED: use a new key only after checking the system state');
        }
      }

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

      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = (body: any) => {
        const statusCode = res.statusCode || 200;
        const responseJson = JSON.parse(JSON.stringify(body));
        const completion = statusCode < 400
          ? prisma.idempotencyRequest.update({
              where: { id: record.id },
              data: {
                status: 'COMPLETED',
                statusCode,
                responseJson,
              },
            })
          : prisma.idempotencyRequest.update({
              where: { id: record.id },
              data: {
                status: 'FAILED',
                statusCode,
              },
            });

        completion
          .then(() => originalJson(body))
          .catch(next);

        return res;
      };

      res.send = (body: any) => {
        return originalSend(body);
      };

      next();
    } catch (err: any) {
      if (err.code === 'P2002') {
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

        return next(new ConflictError('REQUEST_IN_PROGRESS: request is processing'));
      }
      next(err);
    }
  };
}
