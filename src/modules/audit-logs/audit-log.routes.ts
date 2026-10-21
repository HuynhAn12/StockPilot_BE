import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { prisma } from '../../config/db';

export const auditLogRouter = Router();

auditLogRouter.use(authMiddleware);
auditLogRouter.use(requireRole('ADMIN'));

auditLogRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = req.user?.storeId || (req.query.storeId ? parseInt(req.query.storeId as string) : undefined);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;
    const entityType = req.query.entityType as string | undefined;
    const search = req.query.search as string | undefined;

    const where: any = {};
    if (storeId) {
      where.storeId = storeId;
    }
    if (entityType && entityType !== 'ALL') {
      where.entityType = entityType;
    }
    if (search && search.trim()) {
      where.OR = [
        { action: { contains: search.trim() } },
        { entityType: { contains: search.trim() } },
        { entityId: { contains: search.trim() } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const serializedLogs = logs.map((log) => ({
      ...log,
      id: log.id.toString(),
    }));

    return res.status(200).json({
      success: true,
      data: serializedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});
