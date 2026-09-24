import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { z } from 'zod';
import {
  importItemSchema,
  importPreviewSchema,
  importCommitSchema,
  ImportMode,
} from './import-export.schema';
import { toDecimal } from '../../common/utils/decimal';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';

export interface ImportIssue {
  row: number;
  sku: string;
  field: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
}

export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let safe = String(value);

  // Neutralize formula injection (CWE-1236) first
  if (/^[\t\r ]*[=+\-@]/.test(safe)) {
    safe = `'${safe}`;
  }

  // Then CSV-escape the final value if it contains special delimiters
  if (
    safe.includes(',') ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r')
  ) {
    safe = `"${safe.replace(/"/g, '""')}"`;
  }

  return safe;
}

export class ImportExportService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  /**
   * Step 1: Dry-Run validation for bulk import & ImportJob creation
   */
  async previewImport(
    storeId: number,
    userId: number,
    input: z.input<typeof importPreviewSchema>
  ) {
    const parsedInput = importPreviewSchema.parse(input);
    const items = parsedInput.items;
    const mode = parsedInput.mode;
    const totalRows = items.length;
    const issues: ImportIssue[] = [];
    const validItems: typeof items = [];

    const seenSkusInPayload = new Set<string>();
    const invalidRowIndices = new Set<number>();
    const warningRowIndices = new Set<number>();

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const rowNumber = index + 1;
      let hasError = false;

      // 1. Check duplicate SKU within payload
      const normalizedSku = item.sku.trim().toUpperCase();
      if (seenSkusInPayload.has(normalizedSku)) {
        issues.push({
          row: rowNumber,
          sku: item.sku,
          field: 'sku',
          severity: 'ERROR',
          message: `Mã SKU ${item.sku} bị trùng lặp trong danh sách tải lên`,
        });
        hasError = true;
        invalidRowIndices.add(rowNumber);
      } else {
        seenSkusInPayload.add(normalizedSku);
      }

      // 2. Validate price relationship (Warning)
      if (item.sellingPrice < item.costPrice) {
        issues.push({
          row: rowNumber,
          sku: item.sku,
          field: 'sellingPrice',
          severity: 'WARNING',
          message: `Cảnh báo: Giá bán (${item.sellingPrice}) nhỏ hơn giá vốn (${item.costPrice})`,
        });
        warningRowIndices.add(rowNumber);
      }

      if (!hasError) {
        validItems.push(item);
      }
    }

    // 3. Check existing SKUs in database
    const existingStockItems = await this.prisma.stockItem.findMany({
      where: {
        storeId,
        sku: { in: Array.from(seenSkusInPayload) },
      },
      select: { sku: true },
    });

    const existingSkuSet = new Set(existingStockItems.map((s) => s.sku.toUpperCase()));
    const previewItems = items.map((item, idx) => {
      const isExisting = existingSkuSet.has(item.sku.trim().toUpperCase());
      if (isExisting && mode === 'CREATE_ONLY') {
        issues.push({
          row: idx + 1,
          sku: item.sku,
          field: 'sku',
          severity: 'WARNING',
          message: `SKU ${item.sku} đã tồn tại trong hệ thống (Chế độ CREATE_ONLY sẽ bỏ qua cập nhật)`,
        });
        warningRowIndices.add(idx + 1);
      }
      return {
        row: idx + 1,
        ...item,
        isExistingInDb: isExisting,
      };
    });

    const validRowsCount = totalRows - invalidRowIndices.size;
    const invalidRowsCount = invalidRowIndices.size;
    const warningRowsCount = warningRowIndices.size;

    // 4. Compute SHA-256 payload hash and create persistent ImportJob
    const canonicalPayload = JSON.stringify({
      storeId,
      mode,
      warehouseId: input.warehouseId,
      items: items.map((i) => ({
        ...i,
        sku: i.sku.trim(),
        productCode: i.productCode.trim(),
        categoryCode: i.categoryCode.trim(),
      })),
    });

    const payloadHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours TTL

    const job = await this.prisma.importJob.create({
      data: {
        storeId,
        createdById: userId,
        type: 'PRODUCT_BULK_IMPORT',
        payloadHash,
        payloadJson: {
          items,
          mode,
          warehouseId: input.warehouseId,
        },
        status: 'PREVIEWED',
        totalRows,
        validRows: validRowsCount,
        invalidRows: invalidRowsCount,
        warningRows: warningRowsCount,
        expiresAt,
      },
    });

    return {
      jobId: job.id,
      payloadHash,
      mode,
      totalRows,
      validRows: validRowsCount,
      invalidRows: invalidRowsCount,
      warningRows: warningRowsCount,
      issues,
      previewItems,
      expiresAt,
    };
  }

  /**
   * Step 2: Idempotent Batch commit bound by ImportJob
   */
  async commitImport(storeId: number, userId: number, input: z.infer<typeof importCommitSchema>) {
    const job = await this.prisma.importJob.findFirst({
      where: { id: input.jobId, storeId },
    });

    if (!job) {
      throw new NotFoundError('Mã phiên import (jobId) không tồn tại hoặc không thuộc cửa hàng này');
    }

    // Idempotent Replay Protection: If already completed, return stored result without re-mutating stock
    if (job.status === 'COMPLETED' && job.resultJson) {
      return job.resultJson as any;
    }

    if (job.status === 'COMMITTING') {
      throw new ConflictError('Phiên import này đang được hệ thống xử lý, vui lòng không gửi lại');
    }

    if (job.status === 'EXPIRED' || job.expiresAt < new Date()) {
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: { status: 'EXPIRED' },
      });
      throw new ValidationError('Phiên xem trước (preview) đã hết hạn. Vui lòng tạo preview mới');
    }

    // Atomic Status Transition: PREVIEWED / FAILED -> COMMITTING
    const transition = await this.prisma.importJob.updateMany({
      where: {
        id: job.id,
        storeId,
        status: { in: ['PREVIEWED', 'FAILED'] },
      },
      data: {
        status: 'COMMITTING',
      },
    });

    if (transition.count !== 1) {
      const currentJob = await this.prisma.importJob.findUnique({ where: { id: job.id } });
      if (currentJob?.status === 'COMPLETED' && currentJob.resultJson) {
        return currentJob.resultJson as any;
      }
      throw new ConflictError('Không thể thực hiện commit phiên import vào lúc này');
    }

    try {
      const jobData = job.payloadJson as {
        items: z.infer<typeof importItemSchema>[];
        mode?: ImportMode;
        warehouseId?: number;
      };

      const items = jobData.items;
      const mode = input.mode || jobData.mode || 'CREATE_ONLY';
      const targetWarehouseId = input.warehouseId || jobData.warehouseId;

      const warehouse = targetWarehouseId
        ? await this.prisma.warehouse.findFirst({ where: { id: targetWarehouseId, storeId, isActive: true } })
        : await this.prisma.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

      if (!warehouse) {
        throw new NotFoundError('Không tìm thấy kho hàng hợp lệ để thực hiện ghi nhận tồn kho');
      }

      const chunkSize = 100;
      let createdProducts = 0;
      let createdSkus = 0;
      let updatedSkus = 0;
      let skippedSkus = 0;

      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);

        await this.prisma.$transaction(async (tx) => {
          for (const item of chunk) {
            // Check existing SKU
            const existingSku = await tx.stockItem.findUnique({
              where: {
                storeId_sku: {
                  storeId,
                  sku: item.sku.trim(),
                },
              },
            });

            if (existingSku && mode === 'CREATE_ONLY') {
              skippedSkus++;
              continue;
            }

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

            // 4. Handle Stock Inventory according to Mode
            if (!existingSku && item.initialQuantity > 0) {
              // Brand new SKU initial stock inflow
              await StockLedgerService.atomicAdd(
                tx,
                {
                  storeId,
                  warehouseId: warehouse.id,
                  userId,
                  referenceType: 'IMPORT',
                  referenceId: `JOB-${job.id}`,
                  note: `Nhập tồn kho ban đầu từ file bulk import (Job #${job.id})`,
                },
                'INFLOW',
                [{ stockItemId, quantity: item.initialQuantity }]
              );
            } else if (existingSku && mode === 'ADJUST_STOCK' && item.initialQuantity > 0) {
              // Adjust delta stock
              await StockLedgerService.atomicAdd(
                tx,
                {
                  storeId,
                  warehouseId: warehouse.id,
                  userId,
                  referenceType: 'IMPORT_ADJUST',
                  referenceId: `JOB-${job.id}`,
                  note: `Điều chỉnh tăng tồn kho từ bulk import (Job #${job.id})`,
                },
                'INFLOW',
                [{ stockItemId, quantity: item.initialQuantity }]
              );
            }
          }
        });
      }

      const result = {
        success: true,
        message: `Đã import thành công ${items.length} mục hàng`,
        jobId: job.id,
        summary: {
          totalProcessed: items.length,
          createdSkus,
          updatedSkus,
          skippedSkus,
          mode,
        },
      };

      // Mark ImportJob as COMPLETED with saved result
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          resultJson: result,
        },
      });

      return result;
    } catch (err) {
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: { status: 'FAILED' },
      });
      throw err;
    }
  }

  /**
   * Export Products & SKUs as CSV
   */
  async exportProductsCsv(storeId: number, role?: string): Promise<string> {
    const products = await this.prisma.product.findMany({
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
    const balances = await this.prisma.inventoryBalance.findMany({
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

