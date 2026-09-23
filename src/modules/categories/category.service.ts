import { prisma } from '../../config/db';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createCategorySchema, updateCategorySchema } from './category.schema';

export class CategoryService {
  async listCategories(storeId: number, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.category.findMany({
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
      prisma.category.count({ where: { storeId } }),
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
    const category = await prisma.category.findFirst({
      where: { id, storeId },
      include: {
        products: true,
      },
    });

    if (!category) {
      throw new NotFoundError('Không tìm thấy danh mục trong cửa hàng của bạn');
    }

    return category;
  }

  async createCategory(storeId: number, input: z.infer<typeof createCategorySchema>) {
    const existing = await prisma.category.findUnique({
      where: {
        storeId_code: {
          storeId,
          code: input.code.toUpperCase().trim(),
        },
      },
    });

    if (existing) {
      throw new ConflictError('Mã danh mục này đã tồn tại trong cửa hàng');
    }

    return prisma.category.create({
      data: {
        storeId,
        name: input.name.trim(),
        code: input.code.toUpperCase().trim(),
        description: input.description,
      },
    });
  }

  async updateCategory(storeId: number, id: number, input: z.infer<typeof updateCategorySchema>) {
    await this.getCategoryById(storeId, id);

    return prisma.category.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }

  async deleteCategory(storeId: number, id: number) {
    await this.getCategoryById(storeId, id);

    const productCount = await prisma.product.count({
      where: { storeId, categoryId: id },
    });

    if (productCount > 0) {
      throw new ConflictError('Không thể xóa danh mục đang có chứa sản phẩm');
    }

    return prisma.category.delete({
      where: { id },
    });
  }
}
