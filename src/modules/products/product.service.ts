import { prisma } from '../../config/db';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createProductSchema, updateProductSchema } from './product.schema';
import { toDecimal } from '../../common/utils/decimal';

export class ProductService {
  async listProducts(storeId: number) {
    return prisma.product.findMany({
      where: { storeId },
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
      orderBy: { createdAt: 'desc' },
    });
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
      where: { storeId, isDefault: true },
    });

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
        if (defaultWarehouse) {
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
