import { ImportExportService, sanitizeCsvCell } from '../src/modules/import-export/import-export.service';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    category: { upsert: jest.fn() },
    product: { upsert: jest.fn(), findMany: jest.fn() },
    stockItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
    importJob: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
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
  });

  describe('Step 2: Batch Commit Execution via Job ID', () => {
    it('Processes import items in transactions and marks ImportJob as COMPLETED', async () => {
      (prisma as any).importJob.findFirst.mockResolvedValue({
        id: 'job_test_123',
        storeId: 1,
        status: 'PREVIEWED',
        expiresAt: new Date(Date.now() + 60000),
        payloadJson: {
          items: [
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
          ],
          mode: 'CREATE_ONLY',
        },
      });

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
