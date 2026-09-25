import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
export type ImportJobItemStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
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
    const productMetadata = new Map<string, { productName: string; categoryCode: string }>();
    const categoryMetadata = new Map<string, string>();
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

      const normalizedProductCode = item.productCode.trim().toUpperCase();
      const normalizedCategoryCode = item.categoryCode.trim().toUpperCase();
      const existingProductMetadata = productMetadata.get(normalizedProductCode);
      if (
        existingProductMetadata &&
        (existingProductMetadata.productName !== item.productName.trim() ||
          existingProductMetadata.categoryCode !== normalizedCategoryCode)
      ) {
        issues.push({
          row: rowNumber,
          sku: item.sku,
          field: 'productCode',
          severity: 'ERROR',
          message: `Conflicting product metadata for productCode ${item.productCode}`,
        });
        hasError = true;
        invalidRowIndices.add(rowNumber);
      } else {
        productMetadata.set(normalizedProductCode, {
          productName: item.productName.trim(),
          categoryCode: normalizedCategoryCode,
        });
      }

      const existingCategoryName = categoryMetadata.get(normalizedCategoryCode);
      if (existingCategoryName && existingCategoryName !== item.categoryName.trim()) {
        issues.push({
          row: rowNumber,
          sku: item.sku,
          field: 'categoryCode',
          severity: 'ERROR',
          message: `Conflicting category metadata for categoryCode ${item.categoryCode}`,
        });
        hasError = true;
        invalidRowIndices.add(rowNumber);
      } else {
        categoryMetadata.set(normalizedCategoryCode, item.categoryName.trim());
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
      select: { sku: true, product: { select: { code: true } } },
    });

    const existingSkuSet = new Set(existingStockItems.map((s) => s.sku.toUpperCase()));
    const existingSkuProductCode = new Map(
      existingStockItems
        .filter((s: any) => s.product?.code)
        .map((s: any) => [s.sku.toUpperCase(), s.product.code.toUpperCase()])
    );
    const previewItems = items.map((item, idx) => {
      const normalizedSku = item.sku.trim().toUpperCase();
      const isExisting = existingSkuSet.has(normalizedSku);
      const existingProductCode = existingSkuProductCode.get(normalizedSku);
      if (existingProductCode && existingProductCode !== item.productCode.trim().toUpperCase()) {
        issues.push({
          row: idx + 1,
          sku: item.sku,
          field: 'productCode',
          severity: 'ERROR',
          message: `SKU_PRODUCT_MISMATCH: SKU ${item.sku} belongs to product ${existingProductCode}, not ${item.productCode}`,
        });
        invalidRowIndices.add(idx + 1);
      }
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
      if (!isExisting && (mode === 'ADJUST_STOCK' || mode === 'REPLACE_STOCK')) {
        issues.push({
          row: idx + 1,
          sku: item.sku,
          field: 'sku',
          severity: 'ERROR',
          message: `${mode} requires an existing SKU; ${item.sku} was not found`,
        });
        invalidRowIndices.add(idx + 1);
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

    // 4. Compute canonical SHA-256 payload hash
    const payloadJsonToSave = {
      items: items.map((i) => ({
        ...i,
        sku: i.sku.trim(),
        productCode: i.productCode.trim(),
        categoryCode: i.categoryCode.trim(),
      })),
      mode: mode || 'CREATE_ONLY',
      warehouseId: parsedInput.warehouseId ?? null,
    };

    const payloadHash = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(payloadJsonToSave))
      .digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours TTL

    // 5. Create persistent ImportJob & ImportJobItem rows
    const job = await this.prisma.importJob.create({
      data: {
        storeId,
        createdById: userId,
        type: 'PRODUCT_BULK_IMPORT',
        payloadHash,
        payloadJson: payloadJsonToSave as any,
        status: 'PREVIEWED',
        totalRows,
        validRows: validRowsCount,
        invalidRows: invalidRowsCount,
        warningRows: warningRowsCount,
        expiresAt,
      },
    });

    // Create item checkpoints for resilient chunked processing & idempotency
    const jobItemsData = items.map((item, idx) => ({
      importJobId: job.id,
      rowNumber: idx + 1,
      sku: item.sku.trim(),
      status: 'PENDING' as ImportJobItemStatus,
      resultJson: item as any,
    }));

    if (jobItemsData.length > 0) {
      await (this.prisma as any).importJobItem.createMany({
        data: jobItemsData,
      });
    }

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
   * Step 2: Idempotent Batch commit bound strictly by ImportJob (Phase 2 & 3 & 4)
   */
  async commitImport(storeId: number, userId: number, input: z.infer<typeof importCommitSchema>) {
    const job = await this.prisma.importJob.findFirst({
      where: { id: input.jobId, storeId },
    });

    if (!job) {
      throw new NotFoundError('Mã phiên import (jobId) không tồn tại hoặc không thuộc cửa hàng này');
    }

    // Phase 3.4: Guard against committing invalid import jobs
    if (job.invalidRows > 0) {
      throw new ValidationError(`Import job chứa ${job.invalidRows} dòng lỗi và không thể commit`);
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

    // Phase 3.3: Verify payload integrity against SHA-256 hash using canonical stringify
    const calculatedHash = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(job.payloadJson))
      .digest('hex');

    if (calculatedHash !== job.payloadHash) {
      throw new ConflictError('IMPORT_PAYLOAD_TAMPERED: Dữ liệu payload của phiên import đã bị thay đổi bất hợp lệ');
    }

    const jobData = job.payloadJson as {
      items: z.infer<typeof importItemSchema>[];
      mode?: ImportMode;
      warehouseId?: number | null;
    };

    // Phase 3.2: Lock execution parameters from preview payload only
    const mode: ImportMode = jobData.mode || 'CREATE_ONLY';
    const targetWarehouseId = jobData.warehouseId;

    const warehouse = targetWarehouseId
      ? await this.prisma.warehouse.findFirst({ where: { id: targetWarehouseId, storeId, isActive: true } })
      : await this.prisma.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng hợp lệ để thực hiện ghi nhận tồn kho');
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
      // Phase 2: Load pending or failed rows for checkpoint resumption
      const pendingItems: any[] = await (this.prisma as any).importJobItem.findMany({
        where: {
          importJobId: job.id,
          status: { in: ['PENDING', 'FAILED'] },
        },
        orderBy: { rowNumber: 'asc' },
      });

      const checkpointCount = typeof (this.prisma as any).importJobItem.count === 'function'
        ? await (this.prisma as any).importJobItem.count({
            where: { importJobId: job.id },
          })
        : pendingItems.length;

      if (checkpointCount > 0 && pendingItems.length === 0) {
        const completedCount = await (this.prisma as any).importJobItem.count({
          where: { importJobId: job.id, status: 'COMPLETED' },
        });
        const skippedCount = await (this.prisma as any).importJobItem.count({
          where: { importJobId: job.id, status: 'SKIPPED' },
        });

        const result = {
          success: true,
          message: `Đã hoàn tất import từ checkpoint hiện có`,
          jobId: job.id,
          summary: {
            totalProcessed: checkpointCount,
            createdProducts: 0,
            createdSkus: completedCount,
            updatedSkus: 0,
            skippedSkus: skippedCount,
            failedRowsCount: 0,
            mode,
          },
        };

        await this.prisma.importJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            resultJson: result,
          },
        });

        return result;
      }

      // Fallback if importJobItems were not generated in legacy jobs
      const itemsToProcess = pendingItems.length > 0
        ? pendingItems
        : checkpointCount === 0
        ? jobData.items.map((item, idx) => ({
            id: undefined,
            rowNumber: idx + 1,
            sku: item.sku.trim(),
            resultJson: item,
            status: 'PENDING',
          }))
        : [];

      const chunkSize = 100;
      let createdProducts = 0;
      let createdSkus = 0;
      let updatedSkus = 0;
      let skippedSkus = 0;
      let failedRowsCount = 0;

      for (let i = 0; i < itemsToProcess.length; i += chunkSize) {
        const chunk = itemsToProcess.slice(i, i + chunkSize);

        await this.prisma.$transaction(async (tx) => {
          for (const itemRecord of chunk) {
            const item: z.infer<typeof importItemSchema> = itemRecord.resultJson;
            const rowNumber = itemRecord.rowNumber;

            // Mark item as PROCESSING
            if (itemRecord.id) {
              await (tx as any).importJobItem.update({
                where: { id: itemRecord.id },
                data: { status: 'PROCESSING' },
              });
            }

            try {
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
                if (itemRecord.id) {
                  await (tx as any).importJobItem.update({
                    where: { id: itemRecord.id },
                    data: { status: 'SKIPPED' },
                  });
                }
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

              // 4. Handle Stock Inventory according to Mode with Deterministic Idempotency Key
              const deterministicMovementKey = `IMPORT:${job.id}:${rowNumber}:${stockItemId}`;

              if (!existingSku && mode === 'CREATE_ONLY' && item.initialQuantity > 0) {
                // Brand new SKU initial stock inflow
                await StockLedgerService.atomicAdd(
                  tx,
                  {
                    storeId,
                    warehouseId: warehouse.id,
                    userId,
                    referenceType: 'IMPORT',
                    referenceId: `JOB-${job.id}`,
                    idempotencyKey: deterministicMovementKey,
                    note: `Nhập tồn kho ban đầu từ file bulk import (Job #${job.id}, dòng #${rowNumber})`,
                  },
                  'INFLOW',
                  [{ stockItemId, quantity: item.initialQuantity }]
                );
              } else if (existingSku && mode === 'ADJUST_STOCK') {
                const adjQty = item.stockAdjustment;
                if (adjQty === undefined) {
                  throw new ValidationError('ADJUST_STOCK requires stockAdjustment');
                }
                if (adjQty > 0) {
                  await StockLedgerService.atomicAdd(
                    tx,
                    {
                      storeId,
                      warehouseId: warehouse.id,
                      userId,
                      referenceType: 'IMPORT_ADJUST',
                      referenceId: `JOB-${job.id}`,
                      idempotencyKey: deterministicMovementKey,
                      note: `Điều chỉnh tăng tồn kho từ bulk import (Job #${job.id}, dòng #${rowNumber})`,
                    },
                    'INFLOW',
                    [{ stockItemId, quantity: adjQty }]
                  );
                } else if (adjQty < 0) {
                  await StockLedgerService.atomicDeduct(
                    tx,
                    {
                      storeId,
                      warehouseId: warehouse.id,
                      userId,
                      referenceType: 'IMPORT_ADJUST',
                      referenceId: `JOB-${job.id}`,
                      idempotencyKey: deterministicMovementKey,
                      note: `Điều chỉnh giảm tồn kho từ bulk import (Job #${job.id}, dòng #${rowNumber})`,
                    },
                    'OUTFLOW',
                    [{ stockItemId, quantity: Math.abs(adjQty) }]
                  );
                }
              } else if (existingSku && mode === 'REPLACE_STOCK') {
                const targetQty = item.countedQuantity;
                if (targetQty === undefined) {
                  throw new ValidationError('REPLACE_STOCK requires countedQuantity');
                }
                await StockLedgerService.replaceWithCount(
                  tx,
                  {
                    storeId,
                    warehouseId: warehouse.id,
                    userId,
                    referenceType: 'IMPORT_AUDIT',
                    referenceId: `JOB-${job.id}`,
                    idempotencyKey: deterministicMovementKey,
                      note: `Kiểm kê thay thế tồn kho từ bulk import (Job #${job.id}, dòng #${rowNumber})`,
                    },
                  { stockItemId, countedQuantity: targetQty }
                );
              }

              // Mark item as COMPLETED
              if (itemRecord.id) {
                await (tx as any).importJobItem.update({
                  where: { id: itemRecord.id },
                  data: {
                    status: 'COMPLETED',
                    stockItemId,
                  },
                });
              }
            } catch (err: any) {
              failedRowsCount++;
              if (itemRecord.id) {
                await (tx as any).importJobItem.update({
                  where: { id: itemRecord.id },
                  data: {
                    status: 'FAILED',
                    errorJson: { message: err.message || 'Row processing error' },
                  },
                });
              }
              throw err;
            }
          }
        });
      }

      const result = {
        success: true,
        message: `Đã import thành công ${jobData.items.length} mục hàng`,
        jobId: job.id,
        summary: {
          totalProcessed: jobData.items.length,
          createdProducts,
          createdSkus,
          updatedSkus,
          skippedSkus,
          failedRowsCount,
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
      if (typeof (this.prisma as any).importJobItem.updateMany === 'function') {
        await (this.prisma as any).importJobItem.updateMany({
          where: { importJobId: job.id, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorJson: { message: err instanceof Error ? err.message : 'Import failed' },
          },
        });
      }
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

  /**
   * Export Orders as CSV
   */
  async exportOrdersCsv(storeId: number): Promise<string> {
    const orders = await this.prisma.order.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });

    const headers = [
      'Order Number',
      'Status',
      'Customer Name',
      'Customer Phone',
      'Subtotal Amount',
      'Discount Amount',
      'Tax Amount',
      'Total Amount',
      'Created At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const o of orders) {
      const row = [
        sanitizeCsvCell(o.orderNumber),
        sanitizeCsvCell(o.status),
        sanitizeCsvCell(o.customerName || ''),
        sanitizeCsvCell(o.customerPhone || ''),
        sanitizeCsvCell(o.subtotalAmount),
        sanitizeCsvCell(o.discountAmount),
        sanitizeCsvCell(o.taxAmount),
        sanitizeCsvCell(o.totalAmount),
        sanitizeCsvCell(o.createdAt.toISOString()),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Export Sales as CSV
   */
  async exportSalesCsv(storeId: number): Promise<string> {
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        storeId,
        order: { status: 'FULFILLED' },
      },
      include: {
        order: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const headers = [
      'Order Number',
      'SKU',
      'Product Name',
      'Quantity',
      'Unit Price',
      'Subtotal',
      'Sold At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const oi of orderItems) {
      const row = [
        sanitizeCsvCell(oi.order.orderNumber),
        sanitizeCsvCell(oi.skuSnapshot),
        sanitizeCsvCell(oi.nameSnapshot),
        sanitizeCsvCell(oi.quantity),
        sanitizeCsvCell(oi.unitPriceSnapshot),
        sanitizeCsvCell(oi.subtotal),
        sanitizeCsvCell(oi.order.fulfilledAt ? oi.order.fulfilledAt.toISOString() : ''),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Export Returns as CSV
   */
  async exportReturnsCsv(storeId: number): Promise<string> {
    const returns = await this.prisma.returnOrder.findMany({
      where: { storeId },
      include: { order: true },
      orderBy: { createdAt: 'desc' },
    });

    const headers = [
      'Return Number',
      'Order Number',
      'Status',
      'Total Refund Amount',
      'Reason',
      'Created At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const r of returns) {
      const row = [
        sanitizeCsvCell(r.returnNumber),
        sanitizeCsvCell(r.order.orderNumber),
        sanitizeCsvCell(r.status),
        sanitizeCsvCell(r.totalRefundAmount),
        sanitizeCsvCell(r.reason || ''),
        sanitizeCsvCell(r.createdAt.toISOString()),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Export Decision Engine Reports as CSV
   */
  async exportDecisionReportCsv(storeId: number): Promise<string> {
    const stockItems = await this.prisma.stockItem.findMany({
      where: { storeId, isActive: true },
      include: {
        product: true,
        balances: true,
        alerts: {
          where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        },
        pricingRecommendations: {
          where: { status: 'PENDING' },
        },
      },
      orderBy: { sku: 'asc' },
    });

    const headers = [
      'SKU',
      'Product Name',
      'Cost Price',
      'Selling Price',
      'On Hand',
      'Reserved',
      'Available Stock',
      'Min Stock Level',
      'Max Stock Level',
      'Active Alerts Count',
      'Pending Discount (%)',
      'Recommended Price',
    ];

    const rows: string[] = [headers.join(',')];

    for (const s of stockItems) {
      const onHand = s.balances.reduce((acc, b) => acc + b.quantity, 0);
      const reserved = s.balances.reduce((acc, b) => acc + b.reservedQuantity, 0);
      const available = Math.max(0, onHand - reserved);
      const pendingRec = s.pricingRecommendations[0];

      const row = [
        sanitizeCsvCell(s.sku),
        sanitizeCsvCell(s.name),
        sanitizeCsvCell(s.costPrice),
        sanitizeCsvCell(s.sellingPrice),
        sanitizeCsvCell(onHand),
        sanitizeCsvCell(reserved),
        sanitizeCsvCell(available),
        sanitizeCsvCell(s.minStockLevel),
        sanitizeCsvCell(s.maxStockLevel),
        sanitizeCsvCell(s.alerts.length),
        sanitizeCsvCell(pendingRec?.discountPct ? pendingRec.discountPct.toString() : '0'),
        sanitizeCsvCell(pendingRec?.recommendedPrice ? pendingRec.recommendedPrice.toString() : s.sellingPrice.toString()),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Export Alerts as CSV
   */
  async exportAlertsCsv(storeId: number): Promise<string> {
    const alerts = await this.prisma.alert.findMany({
      where: { storeId },
      include: { stockItem: true },
      orderBy: [{ severity: 'desc' }, { openedAt: 'desc' }],
    });

    const headers = [
      'Alert ID',
      'SKU',
      'Product Name',
      'Type',
      'Severity',
      'Status',
      'Risk Score',
      'Confidence',
      'Title',
      'Message',
      'Opened At',
      'Resolved At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const a of alerts) {
      const row = [
        sanitizeCsvCell(a.id),
        sanitizeCsvCell(a.stockItem.sku),
        sanitizeCsvCell(a.stockItem.name),
        sanitizeCsvCell(a.type),
        sanitizeCsvCell(a.severity),
        sanitizeCsvCell(a.status),
        sanitizeCsvCell(a.riskScore ?? ''),
        sanitizeCsvCell(a.confidence ?? ''),
        sanitizeCsvCell(a.title),
        sanitizeCsvCell(a.message),
        sanitizeCsvCell(a.openedAt.toISOString()),
        sanitizeCsvCell(a.resolvedAt ? a.resolvedAt.toISOString() : ''),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Export Pricing Recommendations as CSV
   */
  async exportPricingRecommendationsCsv(storeId: number): Promise<string> {
    const recs = await this.prisma.pricingRecommendation.findMany({
      where: { storeId },
      include: { stockItem: true },
      orderBy: { createdAt: 'desc' },
    });

    const headers = [
      'Recommendation ID',
      'SKU',
      'Product Name',
      'Current Price',
      'Recommended Price',
      'Discount (%)',
      'Action',
      'Status',
      'Final Selected Price',
      'Created At',
      'Expires At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const r of recs) {
      const row = [
        sanitizeCsvCell(r.id),
        sanitizeCsvCell(r.stockItem.sku),
        sanitizeCsvCell(r.stockItem.name),
        sanitizeCsvCell(r.currentPrice),
        sanitizeCsvCell(r.recommendedPrice),
        sanitizeCsvCell(r.discountPct),
        sanitizeCsvCell(r.action),
        sanitizeCsvCell(r.status),
        sanitizeCsvCell(r.finalUserSelectedPrice ?? ''),
        sanitizeCsvCell(r.createdAt.toISOString()),
        sanitizeCsvCell(r.expiresAt ? r.expiresAt.toISOString() : ''),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }
}
