import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, ValidationError } from '../errors/app-error';

export interface IdempotencyOptions {
  operation: string;
  ttlSeconds?: number;
}

export interface IdempotencyContext {
  operation: string;
  key: string;
  requestHash: string;
  effectKey: string;
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
    const effectKey = `${operation}:${storeId}:${key}`;
    (req as any).idempotencyContext = { operation, key, requestHash, effectKey } satisfies IdempotencyContext;

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
          if (existing.expiresAt > now) {
            throw new ConflictError('REQUEST_IN_PROGRESS: request is processing');
          }

          const recovered = await recoverCommittedOutcome(prisma, storeId, operation, effectKey, req);
          if (recovered) {
            await prisma.idempotencyRequest.update({
              where: { id: existing.id },
              data: {
                status: 'COMPLETED',
                statusCode: recovered.statusCode,
                responseJson: recovered.responseJson,
                expiresAt,
              },
            });
            return res.status(recovered.statusCode).json(recovered.responseJson);
          }

          const reclaimed = await prisma.idempotencyRequest.updateMany({
            where: {
              id: existing.id,
              status: 'PROCESSING',
              requestHash,
              expiresAt: { lte: now },
            },
            data: { expiresAt },
          });

          if (reclaimed.count !== 1) {
            throw new ConflictError('REQUEST_IN_PROGRESS: request is processing');
          }

          return installCompletionHooks(prisma, existing.id, res, next);
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

      installCompletionHooks(prisma, record.id, res, next);
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

        if (concurrentRecord && concurrentRecord.requestHash !== requestHash) {
          return next(new ConflictError('IDEMPOTENCY_KEY_REUSED: Idempotency-Key was used with a different request identity'));
        }

        if (concurrentRecord?.status === 'COMPLETED' && concurrentRecord.responseJson) {
          return res.status(concurrentRecord.statusCode || 200).json(concurrentRecord.responseJson);
        }

        if (concurrentRecord?.status === 'PROCESSING' && concurrentRecord.expiresAt <= now) {
          const recovered = await recoverCommittedOutcome(prisma, storeId, operation, effectKey, req);
          if (recovered) {
            await prisma.idempotencyRequest.update({
              where: { id: concurrentRecord.id },
              data: {
                status: 'COMPLETED',
                statusCode: recovered.statusCode,
                responseJson: recovered.responseJson,
                expiresAt,
              },
            });
            return res.status(recovered.statusCode).json(recovered.responseJson);
          }
        }

        return next(new ConflictError('REQUEST_IN_PROGRESS: request is processing'));
      }
      next(err);
    }
  };
}

function installCompletionHooks(prisma: any, recordId: string, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body: any) => {
    const statusCode = res.statusCode || 200;
    const responseJson = JSON.parse(JSON.stringify(body));
    const completion = statusCode < 400
      ? prisma.idempotencyRequest.update({
          where: { id: recordId },
          data: {
            status: 'COMPLETED',
            statusCode,
            responseJson,
          },
        })
      : prisma.idempotencyRequest.update({
          where: { id: recordId },
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

  res.send = (body: any) => originalSend(body);
  next();
}

async function recoverCommittedOutcome(
  prisma: any,
  storeId: number,
  operation: string,
  effectKey: string,
  req: Request
): Promise<{ statusCode: number; responseJson: any } | null> {
  if (operation === 'ORDER_CREATE') {
    const order = await prisma.order.findFirst({
      where: { storeId, clientRequestKey: effectKey },
      include: { items: true },
    });
    return order
      ? { statusCode: 201, responseJson: { success: true, message: 'Order create recovered', data: order } }
      : null;
  }

  if (operation === 'RETURN_CREATE') {
    const returnOrder = await prisma.returnOrder.findFirst({
      where: { storeId, clientRequestKey: effectKey },
      include: { items: true, order: true },
    });
    return returnOrder
      ? { statusCode: 201, responseJson: { success: true, message: 'Return create recovered', data: returnOrder } }
      : null;
  }

  if (operation.startsWith('INVENTORY_')) {
    const movements = await prisma.stockMovement.findMany({
      where: { storeId, idempotencyKey: { startsWith: effectKey } },
      orderBy: { id: 'asc' },
    });
    if (movements.length === 0) return null;

    const warehouse = await prisma.warehouse.findFirst({
      where: { id: movements[0].warehouseId, storeId },
    });
    return {
      statusCode: 200,
      responseJson: {
        success: true,
        message: 'Inventory operation recovered',
        data: { warehouse, movements },
      },
    };
  }

  if (operation === 'ORDER_CONFIRM' || operation === 'ORDER_CANCEL') {
    const orderId = Number(req.params?.id);
    if (!Number.isInteger(orderId) || orderId <= 0) return null;

    const status = operation === 'ORDER_CONFIRM' ? ['CONFIRMED', 'FULFILLED'] : ['CANCELED'];
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId, status: { in: status } },
      include: { items: true },
    });
    return order
      ? { statusCode: 200, responseJson: { success: true, message: 'Order operation recovered', data: order } }
      : null;
  }

  return null;
}
