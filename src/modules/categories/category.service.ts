import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { prisma as defaultPrisma } from '../../config/db';
import { createCategorySchema, updateCategorySchema } from './category.schema';

const CATEGORY_NOT_FOUND_MESSAGE = 'Không tìm thấy danh mục trong cửa hàng của bạn';
const CATEGORY_DUPLICATE_CODE_MESSAGE = 'Mã danh mục này đã tồn tại trong cửa hàng';
const CATEGORY_CHANGED_MESSAGE = 'Danh mục đã thay đổi, vui lòng thử lại';

export class CategoryService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  async listCategories(storeId: number, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.category.findMany({
        where: { storeId },
        include: {
          _count: {
            select: { products: true },
          },
        },
        orderBy: { createdAt: (query?.order as any) || 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.category.count({ where: { storeId } }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getCategoryById(storeId: number, id: number) {
    const category = await this.prisma.category.findFirst({
      where: { id, storeId },
      include: {
        products: true,
      },
    });

    if (!category) {
      throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
    }

    return category;
  }

  async createCategory(storeId: number, input: z.infer<typeof createCategorySchema>, userId?: number) {
    const code = input.code.toUpperCase().trim();
    const existing = await this.prisma.category.findUnique({
      where: {
        storeId_code: {
          storeId,
          code,
        },
      },
    });

    if (existing) {
      throw new ConflictError(CATEGORY_DUPLICATE_CODE_MESSAGE);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.category.create({
          data: {
            storeId,
            name: input.name.trim(),
            code,
            description: input.description,
          },
        });

        await AuditLogService.create(tx, {
          storeId,
          userId: userId ?? null,
          action: 'CATEGORY_CREATED',
          entityType: 'CATEGORY',
          entityId: category.id,
          afterJson: {
            id: category.id,
            code: category.code,
            name: category.name,
            isActive: category.isActive,
          },
        });

        return category;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(CATEGORY_DUPLICATE_CODE_MESSAGE);
      }
      throw error;
    }
  }

  async updateCategory(storeId: number, id: number, input: z.infer<typeof updateCategorySchema>, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id, storeId },
      });

      if (!existing) {
        throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
      }

      const transition = await tx.category.updateMany({
        where: { id, storeId, updatedAt: existing.updatedAt },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      if (transition.count !== 1) {
        throw new ConflictError(CATEGORY_CHANGED_MESSAGE);
      }

      const category = await tx.category.findFirst({
        where: { id, storeId },
      });
      if (!category) {
        throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
      }

      const action = input.isActive === false && existing.isActive
        ? 'CATEGORY_DEACTIVATED'
        : input.isActive === true && !existing.isActive
        ? 'CATEGORY_REACTIVATED'
        : 'CATEGORY_UPDATED';

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action,
        entityType: 'CATEGORY',
        entityId: category.id,
        beforeJson: {
          id: existing.id,
          code: existing.code,
          name: existing.name,
          isActive: existing.isActive,
        },
        afterJson: {
          id: category.id,
          code: category.code,
          name: category.name,
          isActive: category.isActive,
        },
      });

      return category;
    });
  }

  async deleteCategory(storeId: number, id: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id, storeId },
      });

      if (!existing) {
        throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
      }

      const productCount = await tx.product.count({
        where: { storeId, categoryId: id },
      });

      if (productCount > 0) {
        throw new ConflictError('Không thể xóa danh mục đang có chứa sản phẩm');
      }

      const deleted = await tx.category.deleteMany({
        where: { id, storeId, updatedAt: existing.updatedAt },
      });
      if (deleted.count !== 1) {
        throw new ConflictError(CATEGORY_CHANGED_MESSAGE);
      }

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action: 'CATEGORY_DELETED',
        entityType: 'CATEGORY',
        entityId: existing.id,
        beforeJson: {
          id: existing.id,
          code: existing.code,
          name: existing.name,
          isActive: existing.isActive,
        },
      });

      return existing;
    });
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code === 'P2002'
    : (error as { code?: unknown })?.code === 'P2002';
}
