import { prisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createProductSchema, updateProductSchema } from './product.schema';
import { toDecimal } from '../../common/utils/decimal';
import { AuditLogService } from '../../common/services/audit-log.service';
import { uploadImageBuffer } from '../upload/upload.service';

export class ProductService {
  async listProducts(storeId: number, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { storeId };

    if (query?.categoryId) {
      where.categoryId = Number(query.categoryId);
    }

    where.isActive = typeof query?.isActive === 'boolean' ? query.isActive : true;

    if (query?.q && typeof query.q === 'string' && query.q.trim().length > 0) {
      const keyword = query.q.trim();
      where.OR = [
        { name: { contains: keyword } },
        { code: { contains: keyword } },
        { stockItems: { some: { sku: { contains: keyword } } } },
        { stockItems: { some: { barcode: { contains: keyword } } } },
      ];
    }

    const sortField = ['createdAt', 'name', 'code', 'updatedAt', 'id'].includes(query?.sort)
      ? query.sort
      : 'id';
    const sortOrder = query?.order === 'desc' ? 'desc' : 'asc';

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

  async createProduct(storeId: number, input: z.infer<typeof createProductSchema>, userId?: number) {
    const cleanCode = input.code.toUpperCase().trim();
    if (!/^SP[0-9]+$/.test(cleanCode)) {
      throw new ValidationError('Mã sản phẩm chỉ được có định dạng SP kèm số (VD: SP1, SP2...)');
    }

    const existingCode = await prisma.product.findUnique({
      where: {
        storeId_code: {
          storeId,
          code: cleanCode,
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

    for (const sku of skus) {
      if (!/^SP[0-9]+$/.test(sku)) {
        throw new ValidationError('Mã SP chỉ được có định dạng SP kèm số (VD: SP1, SP2...)');
      }
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
      throw new ConflictError(`Mã SP '${existingSKUs[0].sku}' đã tồn tại trong cửa hàng`);
    }

    const barcodes = input.items
      .map((i) => i.barcode?.trim())
      .filter((b): b is string => Boolean(b && b.length > 0));

    if (barcodes.length > 0) {
      const existingBarcode = await prisma.stockItem.findFirst({
        where: {
          storeId,
          barcode: { in: barcodes },
        },
        include: {
          product: { select: { name: true } },
        },
      });

      if (existingBarcode) {
        throw new ConflictError(
          `Mã vạch '${existingBarcode.barcode}' đã tồn tại trên sản phẩm '${existingBarcode.product?.name || existingBarcode.name}'`
        );
      }
    }

    // Find default warehouse to initialize balance row with 0 quantity
    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('No active default warehouse exists for this store');
    }

    let finalImageUrl = (input as any).imageUrl;
    if (typeof finalImageUrl === 'string' && finalImageUrl.startsWith('data:image/')) {
      try {
        const base64Data = finalImageUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const uploaded = await uploadImageBuffer(buffer, 'stockpilot');
        finalImageUrl = uploaded.secureUrl || uploaded.url;
      } catch (err) {
        console.warn('Backend Cloudinary upload error:', err);
        finalImageUrl = null;
      }
    }

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          storeId,
          categoryId: input.categoryId,
          name: input.name.trim(),
          code: input.code.toUpperCase().trim(),
          description: input.description,
          imageUrl: finalImageUrl || null,
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

      const created = await tx.product.findUnique({
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

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action: 'PRODUCT_CREATED',
        entityType: 'PRODUCT',
        entityId: product.id,
        afterJson: {
          id: product.id,
          code: product.code,
          isActive: product.isActive,
          stockItemIds: created?.stockItems.map((item) => item.id) ?? [],
        },
      });

      return created;
    });
  }

  async updateProduct(storeId: number, id: number, input: z.infer<typeof updateProductSchema>, userId?: number) {
    const existingProduct = await this.getProductById(storeId, id);

    if (input.categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: input.categoryId, storeId } });
      if (!cat) throw new NotFoundError('Danh mục không tồn tại');
    }

    let finalImageUrl = (input as any).imageUrl;
    if (typeof finalImageUrl === 'string' && finalImageUrl.startsWith('data:image/')) {
      try {
        const base64Data = finalImageUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const uploaded = await uploadImageBuffer(buffer, 'stockpilot');
        finalImageUrl = uploaded.secureUrl || uploaded.url;
      } catch (err) {
        console.warn('Backend Cloudinary upload error:', err);
        finalImageUrl = null;
      }
    }

    return prisma.$transaction(async (tx) => {
      const newSellingPrice = input.sellingPrice !== undefined ? input.sellingPrice : input.salePrice;
      const newCostPrice = input.costPrice;

      if (newSellingPrice !== undefined || newCostPrice !== undefined) {
        await tx.stockItem.updateMany({
          where: { productId: id, storeId },
          data: {
            ...(newSellingPrice !== undefined ? { sellingPrice: newSellingPrice } : {}),
            ...(newCostPrice !== undefined ? { costPrice: newCostPrice } : {}),
          },
        });
      }

      const updated = await tx.product.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...((input as any).imageUrl !== undefined ? { imageUrl: finalImageUrl || null } : {}),
        },
        include: {
          category: true,
          stockItems: true,
        },
      });

      const action =
        input.isActive === false && existingProduct.isActive
          ? 'PRODUCT_DEACTIVATED'
          : input.isActive === true && !existingProduct.isActive
          ? 'PRODUCT_REACTIVATED'
          : 'PRODUCT_UPDATED';

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action,
        entityType: 'PRODUCT',
        entityId: id,
        beforeJson: {
          id: existingProduct.id,
          name: existingProduct.name,
          categoryId: existingProduct.categoryId,
          description: existingProduct.description,
          isActive: existingProduct.isActive,
        },
        afterJson: {
          id: updated.id,
          name: updated.name,
          categoryId: updated.categoryId,
          description: updated.description,
          isActive: updated.isActive,
        },
      });

      return updated;
    });
  }

  async deleteProduct(storeId: number, id: number, userId?: number) {
    const existingProduct = await this.getProductById(storeId, id);

    return prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: { isActive: false },
        include: { stockItems: true },
      });

      await tx.stockItem.updateMany({
        where: { productId: id, storeId },
        data: { isActive: false },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action: 'PRODUCT_DELETED',
        entityType: 'PRODUCT',
        entityId: id,
        beforeJson: {
          id: existingProduct.id,
          name: existingProduct.name,
          isActive: existingProduct.isActive,
        },
        afterJson: {
          id: updated.id,
          name: updated.name,
          isActive: false,
        },
      });

      return updated;
    });
  }
}
