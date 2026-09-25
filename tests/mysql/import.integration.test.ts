import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ImportExportService, canonicalJsonStringify } from '../../src/modules/import-export/import-export.service';

const rawDbUrl = process.env.TEST_DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const sanitized = url.replace(/^mysql:\/\//, 'http://');
    const parsed = new URL(sanitized);
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    if (
      dbName.includes('production') ||
      dbName.includes('prod') ||
      dbName.includes('_dev') ||
      dbName.includes('dev_')
    ) {
      return false;
    }

    return (
      dbName.includes('_test') ||
      dbName.includes('test_') ||
      dbName.includes('_ci') ||
      dbName.includes('ci_')
    );
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real Import Contract & Recovery Integration', () => {
  let prisma: PrismaClient;
  let service: ImportExportService;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    service = new ImportExportService(prisma);
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('persists FAILED ImportJobItem diagnostics outside rollback when stock adjustment fails', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: {
        name: `Import Store ${suffix}`,
        code: `IMPORT_STORE_${suffix}`,
      },
    });
    createdStoreIds.push(store.id);

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: store.id,
        name: 'Import Warehouse',
        isDefault: true,
      },
    });
    const user = await prisma.user.create({
      data: {
        email: `import_${suffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Import User',
        role: 'SHOP_OWNER',
        storeId: store.id,
      },
    });
    const category = await prisma.category.create({
      data: {
        storeId: store.id,
        name: 'Import Category',
        code: `IMP_CAT_${suffix}`,
      },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: category.id,
        name: 'Import Product',
        code: `IMP_PRD_${suffix}`,
      },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU-IMPORT-${suffix}`,
        name: 'Import SKU',
        costPrice: 10000,
        sellingPrice: 20000,
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: stockItem.id,
        quantity: 0,
      },
    });

    const item = {
      categoryName: category.name,
      categoryCode: category.code,
      productName: product.name,
      productCode: product.code,
      sku: stockItem.sku,
      costPrice: 10000,
      sellingPrice: 20000,
      stockAdjustment: -5,
      minStockLevel: 0,
      maxStockLevel: 100,
    };
    const payloadJson = {
      items: [item],
      mode: 'ADJUST_STOCK',
      warehouseId: null,
    };
    const payloadHash = crypto.createHash('sha256').update(canonicalJsonStringify(payloadJson)).digest('hex');

    const job = await prisma.importJob.create({
      data: {
        storeId: store.id,
        createdById: user.id,
        type: 'PRODUCT_BULK_IMPORT',
        payloadHash,
        payloadJson,
        status: 'PREVIEWED',
        totalRows: 1,
        validRows: 1,
        invalidRows: 0,
        warningRows: 0,
        expiresAt: new Date(Date.now() + 60_000),
        items: {
          create: {
            rowNumber: 1,
            sku: stockItem.sku,
            status: 'PENDING',
            resultJson: item,
          },
        },
      },
    });

    await expect(service.commitImport(store.id, user.id, { jobId: job.id })).rejects.toThrow();

    const itemAfter = await prisma.importJobItem.findFirstOrThrow({
      where: { importJobId: job.id, rowNumber: 1 },
    });
    const jobAfter = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    const movements = await prisma.stockMovement.findMany({ where: { storeId: store.id, stockItemId: stockItem.id } });

    expect(itemAfter.status).toBe('FAILED');
    expect(itemAfter.errorJson).toBeTruthy();
    expect(jobAfter.status).toBe('FAILED');
    expect(movements).toHaveLength(0);
  });
});
