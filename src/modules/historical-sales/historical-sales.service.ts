import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError, ConflictError } from '../../common/errors/app-error';
import { HistoricalSaleRowInput } from './historical-sales.schema';

export class HistoricalSalesService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  public static computeRowHash(
    storeId: number,
    source: string,
    externalOrderId: string | null | undefined,
    sku: string,
    soldAt: Date,
    quantity: number,
    unitPrice: number
  ): string {
    const raw = `${storeId}|${source.trim()}|${(externalOrderId || '').trim()}|${sku.trim()}|${soldAt.toISOString()}|${quantity}|${Number(unitPrice).toFixed(2)}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  public static computePayloadHash(payload: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  async previewHistoricalSales(storeId: number, userId: number, rows: HistoricalSaleRowInput[]) {
    // 1. Fetch existing StockItems for this store to map SKU -> stockItemId
    const skus = Array.from(new Set(rows.map((r) => r.sku.trim())));
    const existingStockItems = await this.prisma.stockItem.findMany({
      where: {
        storeId,
        sku: { in: skus },
      },
      select: {
        id: true,
        sku: true,
        name: true,
      },
    });

    const skuMap = new Map<string, { id: number; name: string }>();
    for (const item of existingStockItems) {
      skuMap.set(item.sku.toLowerCase(), { id: item.id, name: item.name });
    }

    // 2. Compute hashes and check existing records in database to detect duplicates
    const previewItems: Array<{
      rowNumber: number;
      sku: string;
      stockItemId: number | null;
      externalOrderId?: string | null;
      quantity: number;
      unitPrice: number;
      totalAmount: number;
      soldAt: Date;
      source: string;
      sourceRowHash: string;
      status: 'VALID' | 'WARNING' | 'DUPLICATE' | 'INVALID';
      message?: string;
    }> = [];

    const rowHashes: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const hash = HistoricalSalesService.computeRowHash(
        storeId,
        row.source || 'CSV',
        row.externalOrderId,
        row.sku,
        new Date(row.soldAt),
        row.quantity,
        row.unitPrice
      );
      rowHashes.push(hash);
    }

    const existingSales = await this.prisma.historicalSale.findMany({
      where: {
        storeId,
        sourceRowHash: { in: rowHashes },
      },
      select: { sourceRowHash: true },
    });
    const existingHashSet = new Set(existingSales.map((s) => s.sourceRowHash));
    const seenHashesInFile = new Set<string>();

    let validCount = 0;
    let warningCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const hash = rowHashes[i];
      const rowNumber = i + 1;
      const matched = skuMap.get(row.sku.trim().toLowerCase());
      const totalAmount = Number(row.quantity) * Number(row.unitPrice);

      let status: 'VALID' | 'WARNING' | 'DUPLICATE' | 'INVALID' = 'VALID';
      let message: string | undefined;

      if (existingHashSet.has(hash) || seenHashesInFile.has(hash)) {
        status = 'DUPLICATE';
        message = 'Dòng này đã tồn tại trong lịch sử bán hàng hoặc bị trùng lặp trong file';
        duplicateCount++;
      } else if (!matched) {
        status = 'WARNING';
        message = 'SKU chưa có trong danh mục sản phẩm (sẽ được ghi nhận dạng lịch sử chưa gán StockItem)';
        warningCount++;
      } else {
        validCount++;
      }

      seenHashesInFile.add(hash);

      previewItems.push({
        rowNumber,
        sku: row.sku.trim(),
        stockItemId: matched ? matched.id : null,
        externalOrderId: row.externalOrderId || null,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        totalAmount,
        soldAt: new Date(row.soldAt),
        source: row.source || 'CSV',
        sourceRowHash: hash,
        status,
        message,
      });
    }

    // 3. Create ImportJob with expiration (1 hour)
    const payloadHash = HistoricalSalesService.computePayloadHash(rows);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const job = await this.prisma.importJob.create({
      data: {
        storeId,
        createdById: userId,
        type: 'HISTORICAL_SALES',
        payloadHash,
        payloadJson: rows as unknown as Prisma.InputJsonValue,
        status: 'PREVIEWED',
        totalRows: rows.length,
        validRows: validCount,
        warningRows: warningCount,
        invalidRows: duplicateCount + invalidCount,
        expiresAt,
        items: {
          create: previewItems.map((item) => ({
            rowNumber: item.rowNumber,
            stockItemId: item.stockItemId,
            sku: item.sku,
            status: item.status === 'DUPLICATE' || item.status === 'INVALID' ? 'SKIPPED' : 'PENDING',
            resultJson: {
              sourceRowHash: item.sourceRowHash,
              externalOrderId: item.externalOrderId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalAmount: item.totalAmount,
              soldAt: item.soldAt.toISOString(),
              source: item.source,
            },
            errorJson: item.message ? { message: item.message, status: item.status } : undefined,
          })),
        },
      },
    });

    return {
      jobId: job.id,
      totalRows: rows.length,
      validRows: validCount,
      warningRows: warningCount,
      duplicateRows: duplicateCount,
      invalidRows: invalidCount,
      expiresAt,
      previewSample: previewItems.slice(0, 50),
    };
  }

  async commitHistoricalSales(storeId: number, userId: number, jobId: string) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: jobId },
      include: { items: true },
    });

    if (!job || job.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy phiên import lịch sử bán hàng');
    }

    if (job.status === 'COMPLETED') {
      return {
        jobId: job.id,
        status: 'COMPLETED',
        message: 'Job import lịch sử bán hàng đã hoàn tất trước đó',
        result: job.resultJson,
      };
    }

    if (job.status !== 'PREVIEWED') {
      throw new ValidationError(`Không thể commit job ở trạng thái ${job.status}`);
    }

    if (new Date() > job.expiresAt) {
      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { status: 'EXPIRED' },
      });
      throw new ValidationError('Phiên preview import đã hết hạn (quá 60 phút). Vui lòng preview lại');
    }

    // Filter items to import: PENDING items (skipping DUPLICATE / INVALID)
    const itemsToInsert = job.items.filter((item) => item.status === 'PENDING' && item.resultJson);

    if (itemsToInsert.length === 0) {
      throw new ValidationError('Không có dòng hợp lệ nào để import');
    }

    // Execute in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Mark job COMMITTING
      await tx.importJob.update({
        where: { id: jobId },
        data: { status: 'COMMITTING' },
      });

      const recordsData = itemsToInsert.map((item) => {
        const data = item.resultJson as {
          sourceRowHash: string;
          externalOrderId?: string | null;
          quantity: number;
          unitPrice: number;
          totalAmount: number;
          soldAt: string;
          source: string;
        };

        return {
          storeId,
          stockItemId: item.stockItemId,
          externalSku: item.sku,
          quantity: data.quantity,
          unitPrice: new Prisma.Decimal(data.unitPrice),
          totalAmount: new Prisma.Decimal(data.totalAmount),
          soldAt: new Date(data.soldAt),
          source: data.source,
          externalOrderId: data.externalOrderId || null,
          sourceRowHash: data.sourceRowHash,
        };
      });

      // Insert HistoricalSales using createMany with skipDuplicates
      const insertResult = await tx.historicalSale.createMany({
        data: recordsData,
        skipDuplicates: true,
      });

      // Update ImportJobItems to COMPLETED
      await tx.importJobItem.updateMany({
        where: {
          importJobId: jobId,
          status: 'PENDING',
        },
        data: { status: 'COMPLETED' },
      });

      const summaryResult = {
        insertedCount: insertResult.count,
        totalItemsProcessed: itemsToInsert.length,
        committedAt: new Date().toISOString(),
      };

      await tx.importJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          resultJson: summaryResult,
        },
      });

      return summaryResult;
    });

    return {
      jobId,
      status: 'COMPLETED',
      message: `Import thành công ${result.insertedCount} bản ghi lịch sử bán hàng`,
      result,
    };
  }

  async listHistoricalSales(
    storeId: number,
    query: {
      sku?: string;
      stockItemId?: number;
      source?: string;
      from?: Date;
      to?: Date;
      page: number;
      limit: number;
    }
  ) {
    const where: Prisma.HistoricalSaleWhereInput = {
      storeId,
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
      ...(query.sku ? { externalSku: { contains: query.sku } } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.from || query.to
        ? {
            soldAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.historicalSale.count({ where }),
      this.prisma.historicalSale.findMany({
        where,
        orderBy: { soldAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          stockItem: {
            select: {
              id: true,
              sku: true,
              name: true,
            },
          },
        },
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }
}
