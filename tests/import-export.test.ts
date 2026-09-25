import crypto from 'crypto';
import { ImportExportService, sanitizeCsvCell, canonicalJsonStringify } from '../src/modules/import-export/import-export.service';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    category: { upsert: jest.fn() },
    product: { upsert: jest.fn(), findMany: jest.fn() },
    stockItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
    importJob: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    importJobItem: { createMany: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    inventoryBalance: { upsert: jest.fn(), findMany: jest.fn() },
    stockMovement: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('ImportExportService - Production-Grade Bulk Data Processing', () => {
  let service: ImportExportService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ImportExportService();
  });

  describe('Formula Injection Prevention (CWE-1236)', () => {
    it('Prefixes dangerous formula triggers (=, +, -, @) with a single quote', () => {
      expect(sanitizeCsvCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
      expect(sanitizeCsvCell('+123456')).toBe("'+123456");
      expect(sanitizeCsvCell('-5000')).toBe("'-5000");
      expect(sanitizeCsvCell('@cmd')).toBe("'@cmd");
      expect(sanitizeCsvCell('Safe Text')).toBe('Safe Text');
    });

    it('Correctly escapes strings containing commas and quotes', () => {
      expect(sanitizeCsvCell('Product, with comma')).toBe('"Product, with comma"');
      expect(sanitizeCsvCell('Product "quoted"')).toBe('"Product ""quoted"""');
    });
  });

  describe('Step 1: Dry-Run Import Preview with ImportJob', () => {
    it('Detects duplicate SKUs within the upload batch and creates PREVIEWED ImportJob', async () => {
      (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([{ sku: 'SKU-EXISTING' }]);
      (prisma as any).importJob.create.mockResolvedValue({ id: 'job_test_123', status: 'PREVIEWED' });
      (prisma as any).importJobItem.createMany.mockResolvedValue({ count: 3 });

      const result = await service.previewImport(1, 100, {
        items: [
          {
            categoryName: 'Thời trang',
            categoryCode: 'TT',
            productName: 'Áo thun 1',
            productCode: 'AT1',
            sku: 'SKU-01',
            costPrice: 50000,
            sellingPrice: 100000,
            initialQuantity: 10,
            minStockLevel: 5,
            maxStockLevel: 500,
          },
          {
            categoryName: 'Thời trang',
            categoryCode: 'TT',
            productName: 'Áo thun 2',
            productCode: 'AT2',
            sku: 'SKU-01', // Trùng SKU với dòng 1
            costPrice: 50000,
            sellingPrice: 100000,
            initialQuantity: 10,
            minStockLevel: 5,
            maxStockLevel: 500,
          },
          {
            categoryName: 'Thời trang',
            categoryCode: 'TT',
            productName: 'Áo thun 3',
            productCode: 'AT3',
            sku: 'SKU-EXISTING',
            costPrice: 50000,
            sellingPrice: 100000,
            initialQuantity: 10,
            minStockLevel: 5,
            maxStockLevel: 500,
          },
        ],
      });

      expect(result.jobId).toBe('job_test_123');
      expect(result.totalRows).toBe(3);
      expect(result.invalidRows).toBe(1);
      expect(result.validRows).toBe(2);
      expect(result.issues[0].message).toContain('bị trùng lặp');
      expect(result.previewItems[2].isExistingInDb).toBe(true);
      expect((prisma as any).importJob.create).toHaveBeenCalled();
    });

    it('Rejects ADJUST_STOCK without stockAdjustment and REPLACE_STOCK without countedQuantity', async () => {
      const baseItem = {
        categoryName: 'Category',
        categoryCode: 'CAT',
        productName: 'Product',
        productCode: 'PRD',
        sku: 'SKU-STRICT',
        costPrice: 50000,
        sellingPrice: 100000,
        minStockLevel: 5,
        maxStockLevel: 500,
      };

      await expect(
        service.previewImport(1, 100, {
          mode: 'ADJUST_STOCK',
          items: [{ ...baseItem }],
        })
      ).rejects.toThrow('ADJUST_STOCK requires stockAdjustment');

      await expect(
        service.previewImport(1, 100, {
          mode: 'REPLACE_STOCK',
          items: [{ ...baseItem }],
        })
      ).rejects.toThrow('REPLACE_STOCK requires countedQuantity');
    });

    it('Rejects stock mutation modes for new SKUs during preview', async () => {
      (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([]);
      (prisma as any).importJob.create.mockResolvedValue({ id: 'job_adjust_new_sku', status: 'PREVIEWED' });
      (prisma as any).importJobItem.createMany.mockResolvedValue({ count: 1 });

      const result = await service.previewImport(1, 100, {
        mode: 'ADJUST_STOCK',
        items: [
          {
            categoryName: 'Category',
            categoryCode: 'CAT',
            productName: 'Product',
            productCode: 'PRD',
            sku: 'SKU-NEW',
            costPrice: 50000,
            sellingPrice: 100000,
            stockAdjustment: 5,
            minStockLevel: 5,
            maxStockLevel: 500,
          },
        ],
      });

      expect(result.invalidRows).toBe(1);
      expect(result.issues[0].message).toContain('requires an existing SKU');
    });
  });

  describe('Step 2: Batch Commit Execution via Job ID', () => {
    it('Processes import items in transactions and marks ImportJob as COMPLETED', async () => {
      const testItems = [
        {
          categoryName: 'Điện tử',
          categoryCode: 'DT',
          productName: 'Tai nghe Bluetooth',
          productCode: 'TN-BT',
          sku: 'SKU-TN01',
          costPrice: 150000,
          sellingPrice: 300000,
          initialQuantity: 50,
          minStockLevel: 10,
          maxStockLevel: 200,
        },
      ];

      const payloadJson = {
        items: testItems.map((i) => ({
          ...i,
          sku: i.sku.trim(),
          productCode: i.productCode.trim(),
          categoryCode: i.categoryCode.trim(),
        })),
        mode: 'CREATE_ONLY',
        warehouseId: null,
      };

      const payloadHash = crypto
        .createHash('sha256')
        .update(canonicalJsonStringify(payloadJson))
        .digest('hex');

      (prisma as any).importJob.findFirst.mockResolvedValue({
        id: 'job_test_123',
        storeId: 1,
        status: 'PREVIEWED',
        invalidRows: 0,
        payloadHash,
        expiresAt: new Date(Date.now() + 60000),
        payloadJson,
      });

      (prisma as any).importJobItem.findMany.mockResolvedValue([
        {
          id: 1,
          importJobId: 'job_test_123',
          rowNumber: 1,
          sku: 'SKU-TN01',
          status: 'PENDING',
          resultJson: testItems[0],
        },
      ]);
      (prisma as any).importJobItem.update.mockResolvedValue({});

      (prisma as any).importJob.updateMany.mockResolvedValue({ count: 1 });
      (prisma as any).importJob.update.mockResolvedValue({ id: 'job_test_123', status: 'COMPLETED' });

      (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
      (prisma.category.upsert as jest.Mock).mockResolvedValue({ id: 10 });
      (prisma.product.upsert as jest.Mock).mockResolvedValue({ id: 20 });
      (prisma.stockItem.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.stockItem.create as jest.Mock).mockResolvedValue({ id: 30 });
      (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 30, storeId: 1, isActive: true });
      (prisma.inventoryBalance.upsert as jest.Mock).mockResolvedValue({ id: 40, quantity: 50 });

      const result = await service.commitImport(1, 100, {
        jobId: 'job_test_123',
      });

      expect(result.success).toBe(true);
      expect(result.summary.createdSkus).toBe(1);
      expect(prisma.category.upsert).toHaveBeenCalled();
      expect(prisma.product.upsert).toHaveBeenCalled();
      expect(prisma.stockItem.create).toHaveBeenCalled();
      expect(prisma.stockMovement.create).toHaveBeenCalled();
      expect((prisma as any).importJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        })
      );
    });

    it('Persists failed checkpoint diagnostics after business transaction rollback', async () => {
      const testItem = {
        categoryName: 'Category',
        categoryCode: 'CAT',
        productName: 'Product',
        productCode: 'PRD',
        sku: 'SKU-FAIL',
        costPrice: 50000,
        sellingPrice: 100000,
        initialQuantity: 10,
        minStockLevel: 5,
        maxStockLevel: 500,
      };
      const payloadJson = {
        items: [testItem],
        mode: 'CREATE_ONLY',
        warehouseId: null,
      };
      const payloadHash = crypto
        .createHash('sha256')
        .update(canonicalJsonStringify(payloadJson))
        .digest('hex');

      (prisma as any).importJob.findFirst.mockResolvedValue({
        id: 'job_fail_123',
        storeId: 1,
        status: 'PREVIEWED',
        invalidRows: 0,
        payloadHash,
        expiresAt: new Date(Date.now() + 60000),
        payloadJson,
      });
      (prisma as any).importJobItem.findMany.mockResolvedValue([
        {
          id: 1,
          importJobId: 'job_fail_123',
          rowNumber: 1,
          sku: 'SKU-FAIL',
          status: 'PENDING',
          resultJson: testItem,
        },
      ]);
      (prisma as any).importJob.updateMany.mockResolvedValue({ count: 1 });
      (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
      (prisma.stockItem.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.category.upsert as jest.Mock).mockRejectedValue(new Error('category rollback test'));
      (prisma as any).importJob.update.mockResolvedValue({ id: 'job_fail_123', status: 'FAILED' });

      await expect(service.commitImport(1, 100, { jobId: 'job_fail_123' })).rejects.toThrow('category rollback test');

      expect((prisma as any).importJobItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'PROCESSING' },
        })
      );
      expect((prisma as any).importJobItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorJson: expect.objectContaining({ message: 'category rollback test' }),
          }),
        })
      );
      expect((prisma as any).importJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'FAILED' },
        })
      );
    });
  });

  describe('CSV Exports', () => {
    it('Exports products CSV and hides costPrice for WAREHOUSE_STAFF', async () => {
      (prisma.product.findMany as jest.Mock).mockResolvedValue([
        {
          code: 'P01',
          name: 'Sản phẩm 1',
          category: { code: 'CAT1', name: 'Danh mục 1' },
          stockItems: [
            {
              sku: 'SKU01',
              barcode: '123456',
              costPrice: 50000,
              sellingPrice: 100000,
              minStockLevel: 5,
              maxStockLevel: 100,
              isActive: true,
            },
          ],
        },
      ]);

      const staffCsv = await service.exportProductsCsv(1, 'WAREHOUSE_STAFF');
      expect(staffCsv).not.toContain('Cost Price');
      expect(staffCsv).not.toContain('50000');

      const ownerCsv = await service.exportProductsCsv(1, 'SHOP_OWNER');
      expect(ownerCsv).toContain('Cost Price');
      expect(ownerCsv).toContain('50000');
    });
  });
});
