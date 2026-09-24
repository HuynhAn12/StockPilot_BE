import { prisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createProductSchema, updateProductSchema } from './product.schema';
import { toDecimal } from '../../common/utils/decimal';

export class ProductService {
  async listProducts(storeId: number, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { storeId };

    if (query?.categoryId) {
      where.categoryId = Number(query.categoryId);
    }

    if (typeof query?.isActive === 'boolean') {
      where.isActive = query.isActive;
    }

    if (query?.q && typeof query.q === 'string' && query.q.trim().length > 0) {
      const keyword = query.q.trim();
      where.OR = [
        { name: { contains: keyword } },
        { code: { contains: keyword } },
        { stockItems: { some: { sku: { contains: keyword } } } },
        { stockItems: { some: { barcode: { contains: keyword } } } },
      ];
    }

    const sortField = ['createdAt', 'name', 'code', 'updatedAt'].includes(query?.sort)
      ? query.sort
      : 'createdAt';
    const sortOrder = query?.order === 'asc' ? 'asc' : 'desc';

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: true,
          stockItems: {
            include: {
              balances: {
                include: {
                  warehouse: true,
                },
              },
            },
          },
        },
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limit,
      }),
      prisma.product.count({ where }),
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

  async getProductById(storeId: number, id: number) {
    const product = await prisma.product.findFirst({
      where: { id, storeId },
      include: {
        category: true,
        stockItems: {
          include: {
            balances: {
              include: {
                warehouse: true,
              },
            },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundError('Không tìm thấy sản phẩm trong cửa hàng');
    }

    return product;
  }

  async createProduct(storeId: number, input: z.infer<typeof createProductSchema>) {
    const existingCode = await prisma.product.findUnique({
      where: {
        storeId_code: {
          storeId,
          code: input.code.toUpperCase().trim(),
        },
      },
    });

    if (existingCode) {
      throw new ConflictError('Mã sản phẩm này đã tồn tại trong cửa hàng');
    }

    if (input.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: input.categoryId, storeId },
      });
      if (!category) {
        throw new NotFoundError('Danh mục đã chọn không tồn tại');
      }
    }

    // Check SKU duplicates within store
    const skus = input.items.map((i) => i.sku.toUpperCase().trim());
    if (new Set(skus).size !== skus.length) {
      throw new ValidationError('Duplicate SKU in the same product request');
    }

    const invalidThreshold = input.items.find((i) => i.minStockLevel > i.maxStockLevel);
    if (invalidThreshold) {
      throw new ValidationError(`minStockLevel must be less than or equal to maxStockLevel for SKU ${invalidThreshold.sku}`);
    }

    const existingSKUs = await prisma.stockItem.findMany({
      where: {
        storeId,
        sku: { in: skus },
      },
    });

    if (existingSKUs.length > 0) {
      throw new ConflictError(`Mã SKU '${existingSKUs[0].sku}' đã tồn tại trong cửa hàng`);
    }

    // Find default warehouse to initialize balance row with 0 quantity
    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('No active default warehouse exists for this store');
    }

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          storeId,
          categoryId: input.categoryId,
          name: input.name.trim(),
          code: input.code.toUpperCase().trim(),
          description: input.description,
        },
      });

      for (const item of input.items) {
        const stockItem = await tx.stockItem.create({
          data: {
            storeId,
            productId: product.id,
            sku: item.sku.toUpperCase().trim(),
            name: item.name.trim(),
            barcode: item.barcode,
            costPrice: toDecimal(item.costPrice),
            sellingPrice: toDecimal(item.sellingPrice),
            minStockLevel: item.minStockLevel,
            maxStockLevel: item.maxStockLevel,
          },
        });

        // Initialize balance with 0
        await tx.inventoryBalance.create({
          data: {
            storeId,
            warehouseId: defaultWarehouse.id,
            stockItemId: stockItem.id,
            quantity: 0,
            reservedQuantity: 0,
          },
        });
      }

      return tx.product.findUnique({
        where: { id: product.id },
        include: {
          category: true,
          stockItems: {
            include: {
              balances: true,
            },
          },
        },
      });
    });
  }

  async updateProduct(storeId: number, id: number, input: z.infer<typeof updateProductSchema>) {
    await this.getProductById(storeId, id);

    if (input.categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: input.categoryId, storeId } });
      if (!cat) throw new NotFoundError('Danh mục không tồn tại');
    }

    return prisma.product.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      include: {
        category: true,
        stockItems: true,
      },
    });
  }
}
