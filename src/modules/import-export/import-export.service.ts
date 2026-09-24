import { prisma } from '../../config/db';
import { z } from 'zod';
import { importItemSchema, importCommitSchema } from './import-export.schema';
import { toDecimal } from '../../common/utils/decimal';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { NotFoundError } from '../../common/errors/app-error';

export function sanitizeCsvCell(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Guard against CSV / Excel formula injection (CWE-1236)
  if (/^[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  // Escape quotes if needed
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class ImportExportService {
  /**
   * Step 1: Dry-Run validation for bulk import
   */
  async previewImport(storeId: number, items: z.infer<typeof importItemSchema>[]) {
    const totalRows = items.length;
    const errors: Array<{ row: number; sku: string; field: string; message: string }> = [];
    const validItems: typeof items = [];

    const seenSkusInPayload = new Set<string>();

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const rowNumber = index + 1;
      let hasError = false;

      // 1. Check duplicate SKU within payload
      const normalizedSku = item.sku.trim().toUpperCase();
      if (seenSkusInPayload.has(normalizedSku)) {
        errors.push({
          row: rowNumber,
          sku: item.sku,
          field: 'sku',
          message: `Mã SKU ${item.sku} bị trùng lặp trong danh sách tải lên`,
        });
        hasError = true;
      } else {
        seenSkusInPayload.add(normalizedSku);
      }

      // 2. Validate price relationship
      if (item.sellingPrice < item.costPrice) {
        errors.push({
          row: rowNumber,
          sku: item.sku,
          field: 'sellingPrice',
          message: `Cảnh báo: Giá bán (${item.sellingPrice}) nhỏ hơn giá vốn (${item.costPrice})`,
        });
      }

      if (!hasError) {
        validItems.push(item);
      }
    }

    // 3. Check existing SKUs in database
    const existingStockItems = await prisma.stockItem.findMany({
      where: {
        storeId,
        sku: { in: Array.from(seenSkusInPayload) },
      },
      select: { sku: true },
    });

    const existingSkuSet = new Set(existingStockItems.map((s) => s.sku.toUpperCase()));
    const previewItems = items.map((item, idx) => ({
      row: idx + 1,
      ...item,
      isExistingInDb: existingSkuSet.has(item.sku.trim().toUpperCase()),
    }));

    return {
      totalRows,
      validRows: validItems.length,
      invalidRows: errors.length,
      errors,
      previewItems,
    };
  }

  /**
   * Step 2: Batch commit with transaction chunking (100 rows per transaction)
   */
  async commitImport(storeId: number, userId: number, input: z.infer<typeof importCommitSchema>) {
    const warehouse = input.warehouseId
      ? await prisma.warehouse.findFirst({ where: { id: input.warehouseId, storeId, isActive: true } })
      : await prisma.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng để ghi nhận tồn kho ban đầu');
    }

    const chunkSize = 100;
    let createdProducts = 0;
    let createdSkus = 0;
    let updatedSkus = 0;

    for (let i = 0; i < input.items.length; i += chunkSize) {
      const chunk = input.items.slice(i, i + chunkSize);

      await prisma.$transaction(async (tx) => {
        for (const item of chunk) {
          // 1. Upsert Category
          const category = await tx.category.upsert({
            where: {
              storeId_code: {
                storeId,
                code: item.categoryCode.trim().toUpperCase(),
              },
            },
            create: {
              storeId,
              name: item.categoryName.trim(),
              code: item.categoryCode.trim().toUpperCase(),
            },
            update: {
              name: item.categoryName.trim(),
            },
          });

          // 2. Upsert Product
          const product = await tx.product.upsert({
            where: {
              storeId_code: {
                storeId,
                code: item.productCode.trim().toUpperCase(),
              },
            },
            create: {
              storeId,
              categoryId: category.id,
              name: item.productName.trim(),
              code: item.productCode.trim().toUpperCase(),
            },
            update: {
              name: item.productName.trim(),
              categoryId: category.id,
            },
          });
          createdProducts++;

          // 3. Upsert StockItem
          const existingSku = await tx.stockItem.findUnique({
            where: {
              storeId_sku: {
                storeId,
                sku: item.sku.trim(),
              },
            },
          });

          let stockItemId: number;

          if (existingSku) {
            const updated = await tx.stockItem.update({
              where: { id: existingSku.id },
              data: {
                name: item.productName.trim(),
                barcode: item.barcode || existingSku.barcode,
                costPrice: toDecimal(item.costPrice),
                sellingPrice: toDecimal(item.sellingPrice),
                minStockLevel: item.minStockLevel,
                maxStockLevel: item.maxStockLevel,
              },
            });
            stockItemId = updated.id;
            updatedSkus++;
          } else {
            const created = await tx.stockItem.create({
              data: {
                storeId,
                productId: product.id,
                sku: item.sku.trim(),
                name: item.productName.trim(),
                barcode: item.barcode,
                costPrice: toDecimal(item.costPrice),
                sellingPrice: toDecimal(item.sellingPrice),
                minStockLevel: item.minStockLevel,
                maxStockLevel: item.maxStockLevel,
              },
            });
            stockItemId = created.id;
            createdSkus++;
          }

          // 4. If initialQuantity > 0, set or add opening balance
          if (item.initialQuantity > 0) {
            await StockLedgerService.atomicAdd(
              tx,
              {
                storeId,
                warehouseId: warehouse.id,
                userId,
                referenceType: 'IMPORT',
                referenceId: `IMPORT-${Date.now()}`,
                note: `Nhập tồn kho ban đầu từ file bulk import`,
              },
              'INFLOW',
              [{ stockItemId, quantity: item.initialQuantity }]
            );
          }
        }
      });
    }

    return {
      success: true,
      message: `Đã import thành công ${input.items.length} mục hàng`,
      summary: {
        totalProcessed: input.items.length,
        createdSkus,
        updatedSkus,
      },
    };
  }

  /**
   * Export Products & SKUs as CSV
   */
  async exportProductsCsv(storeId: number, role?: string): Promise<string> {
    const products = await prisma.product.findMany({
      where: { storeId },
      include: {
        category: true,
        stockItems: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const isStaff = role === 'WAREHOUSE_STAFF';

    const headers = [
      'Category Code',
      'Category Name',
      'Product Code',
      'Product Name',
      'SKU',
      'Barcode',
      ...(isStaff ? [] : ['Cost Price']),
      'Selling Price',
      'Min Stock Level',
      'Max Stock Level',
      'Status',
    ];

    const rows: string[] = [headers.join(',')];

    for (const p of products) {
      for (const s of p.stockItems) {
        const row = [
          sanitizeCsvCell(p.category?.code || ''),
          sanitizeCsvCell(p.category?.name || ''),
          sanitizeCsvCell(p.code),
          sanitizeCsvCell(p.name),
          sanitizeCsvCell(s.sku),
          sanitizeCsvCell(s.barcode || ''),
          ...(isStaff ? [] : [sanitizeCsvCell(s.costPrice)]),
          sanitizeCsvCell(s.sellingPrice),
          sanitizeCsvCell(s.minStockLevel),
          sanitizeCsvCell(s.maxStockLevel),
          sanitizeCsvCell(s.isActive ? 'ACTIVE' : 'INACTIVE'),
        ];
        rows.push(row.join(','));
      }
    }

    return rows.join('\n');
  }

  /**
   * Export Inventory Balances as CSV
   */
  async exportInventoryCsv(storeId: number, role?: string): Promise<string> {
    const balances = await prisma.inventoryBalance.findMany({
      where: { storeId },
      include: {
        warehouse: true,
        stockItem: {
          include: { product: true },
        },
      },
      orderBy: { stockItemId: 'asc' },
    });

    const isStaff = role === 'WAREHOUSE_STAFF';

    const headers = [
      'Warehouse',
      'Product Name',
      'SKU',
      'Barcode',
      'Quantity',
      'Reserved Quantity',
      'Available Quantity',
      ...(isStaff ? [] : ['Cost Price']),
      'Selling Price',
    ];

    const rows: string[] = [headers.join(',')];

    for (const b of balances) {
      const available = Math.max(0, b.quantity - b.reservedQuantity);
      const row = [
        sanitizeCsvCell(b.warehouse.name),
        sanitizeCsvCell(b.stockItem.name),
        sanitizeCsvCell(b.stockItem.sku),
        sanitizeCsvCell(b.stockItem.barcode || ''),
        sanitizeCsvCell(b.quantity),
        sanitizeCsvCell(b.reservedQuantity),
        sanitizeCsvCell(available),
        ...(isStaff ? [] : [sanitizeCsvCell(b.stockItem.costPrice)]),
        sanitizeCsvCell(b.stockItem.sellingPrice),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }
}
