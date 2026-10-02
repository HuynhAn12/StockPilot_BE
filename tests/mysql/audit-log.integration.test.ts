import { PrismaClient, Role, StockTakeStatus } from '@prisma/client';
import { AuditLogService } from '../../src/common/services/audit-log.service';
import { ConflictError, NotFoundError } from '../../src/common/errors/app-error';
import { CategoryService } from '../../src/modules/categories/category.service';
import { StockTakeService } from '../../src/modules/stock-takes/stock-take.service';

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

(isLiveDb ? describe : describe.skip)('MySQL AuditLog transaction and tenant behavior', () => {
  let prisma: PrismaClient;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createStore(prefix: string) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: {
        name: `${prefix} Store ${suffix}`,
        code: `${prefix.toLowerCase()}-${suffix}`.replace(/_/g, '-'),
      },
    });
    createdStoreIds.push(store.id);
    return { store, suffix };
  }

  async function createUser(storeId: number, suffix: string) {
    return prisma.user.create({
      data: {
        storeId,
        email: `audit-${suffix}@example.test`,
        passwordHash: 'test-hash',
        fullName: `Audit User ${suffix}`,
        role: Role.SHOP_OWNER,
      },
    });
  }

  it('rolls back audit rows when the enclosing transaction fails', async () => {
    const { store, suffix } = await createStore('AuditRollback');
    const action = `AUDIT_ROLLBACK_${suffix}`;

    await expect(
      prisma.$transaction(async (tx) => {
        await AuditLogService.create(tx, {
          storeId: store.id,
          userId: null,
          action,
          entityType: 'AUDIT_TEST',
          entityId: suffix,
          afterJson: { status: 'written-before-error' },
        });

        throw new Error('rollback audit test');
      })
    ).rejects.toThrow('rollback audit test');

    const auditCount = await prisma.auditLog.count({
      where: { storeId: store.id, action, entityType: 'AUDIT_TEST' },
    });
    expect(auditCount).toBe(0);
  });

  it('keeps audit log reads isolated by storeId', async () => {
    const left = await createStore('AuditLeft');
    const right = await createStore('AuditRight');
    const action = `AUDIT_TENANT_${left.suffix}`;

    await AuditLogService.create(prisma, {
      storeId: left.store.id,
      userId: null,
      action,
      entityType: 'AUDIT_TEST',
      entityId: 'left',
      afterJson: { marker: 'left' },
    });
    await AuditLogService.create(prisma, {
      storeId: right.store.id,
      userId: null,
      action,
      entityType: 'AUDIT_TEST',
      entityId: 'right',
      afterJson: { marker: 'right' },
    });

    const leftLogs = await prisma.auditLog.findMany({
      where: { storeId: left.store.id, action },
      orderBy: { id: 'asc' },
    });

    expect(leftLogs).toHaveLength(1);
    expect(leftLogs[0].entityId).toBe('left');
  });

  it('commits category mutation and audit together when both succeed', async () => {
    const { store, suffix } = await createStore('AuditCategoryCommit');
    const user = await createUser(store.id, suffix);
    const service = new CategoryService(prisma);

    const category = await service.createCategory(store.id, { code: `CAT_${suffix}`, name: 'Committed Category' }, user.id);

    const [storedCategory, auditLog] = await Promise.all([
      prisma.category.findFirst({ where: { id: category.id, storeId: store.id } }),
      prisma.auditLog.findFirst({
        where: {
          storeId: store.id,
          userId: user.id,
          action: 'CATEGORY_CREATED',
          entityType: 'CATEGORY',
          entityId: String(category.id),
        },
      }),
    ]);

    expect(storedCategory?.name).toBe('Committed Category');
    expect(auditLog).not.toBeNull();
  });

  it('rolls back category creation when audit creation fails inside the transaction', async () => {
    const { store, suffix } = await createStore('AuditCategoryRollback');
    const user = await createUser(store.id, suffix);
    const failingPrisma = new Proxy(prisma as any, {
      get(target, prop) {
        if (prop !== '$transaction') return target[prop];
        return (callback: (tx: any) => Promise<unknown>) =>
          prisma.$transaction((tx) => {
            const txProxy = new Proxy(tx as any, {
              get(txTarget, txProp) {
                if (txProp !== 'auditLog') return txTarget[txProp];
                return {
                  ...txTarget.auditLog,
                  create: jest.fn().mockRejectedValue(new Error('forced audit failure')),
                };
              },
            });
            return callback(txProxy);
          });
      },
    });
    const service = new CategoryService(failingPrisma as PrismaClient);
    const code = `ROLL_${suffix}`;

    await expect(service.createCategory(store.id, { code, name: 'Rolled Back Category' }, user.id)).rejects.toThrow(
      'forced audit failure'
    );

    const [categoryCount, auditCount] = await Promise.all([
      prisma.category.count({ where: { storeId: store.id, code } }),
      prisma.auditLog.count({ where: { storeId: store.id, action: 'CATEGORY_CREATED' } }),
    ]);
    expect(categoryCount).toBe(0);
    expect(auditCount).toBe(0);
  });

  it('does not write category audit when duplicate category creation fails', async () => {
    const { store, suffix } = await createStore('AuditCategoryDuplicate');
    const user = await createUser(store.id, suffix);
    const service = new CategoryService(prisma);
    const code = `DUP_${suffix}`;

    await service.createCategory(store.id, { code, name: 'First Category' }, user.id);
    await expect(service.createCategory(store.id, { code, name: 'Duplicate Category' }, user.id)).rejects.toThrow(
      ConflictError
    );

    const auditCount = await prisma.auditLog.count({
      where: { storeId: store.id, action: 'CATEGORY_CREATED' },
    });
    expect(auditCount).toBe(1);
  });

  it('rejects cross-store category update/delete without mutation or misleading audit', async () => {
    const left = await createStore('AuditCategoryLeft');
    const right = await createStore('AuditCategoryRight');
    const user = await createUser(right.store.id, right.suffix);
    const service = new CategoryService(prisma);
    const category = await prisma.category.create({
      data: {
        storeId: left.store.id,
        code: `XSTORE_${left.suffix}`,
        name: 'Left Category',
      },
    });

    await expect(service.updateCategory(right.store.id, category.id, { name: 'Wrong Store' }, user.id)).rejects.toThrow(
      NotFoundError
    );
    await expect(service.deleteCategory(right.store.id, category.id, user.id)).rejects.toThrow(NotFoundError);

    const [unchanged, rightAuditCount] = await Promise.all([
      prisma.category.findUnique({ where: { id: category.id } }),
      prisma.auditLog.count({
        where: {
          storeId: right.store.id,
          entityType: 'CATEGORY',
          entityId: String(category.id),
        },
      }),
    ]);
    expect(unchanged?.name).toBe('Left Category');
    expect(rightAuditCount).toBe(0);
  });

  it('rejects terminal stock-take cancel without inventory mutation or cancel audit', async () => {
    const { store, suffix } = await createStore('AuditStockTakeCancel');
    const user = await createUser(store.id, suffix);
    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: store.id,
        name: 'Audit Warehouse',
      },
    });
    const stockTake = await prisma.stockTake.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        createdById: user.id,
        status: StockTakeStatus.CANCELED,
      },
    });
    const service = new StockTakeService(prisma);

    await expect(service.cancel(store.id, user.id, stockTake.id)).rejects.toThrow(ConflictError);

    const [auditCount, movementCount, latest] = await Promise.all([
      prisma.auditLog.count({
        where: { storeId: store.id, action: 'STOCK_TAKE_CANCELED', entityId: String(stockTake.id) },
      }),
      prisma.stockMovement.count({ where: { storeId: store.id, referenceType: 'STOCK_TAKE' } }),
      prisma.stockTake.findUnique({ where: { id: stockTake.id } }),
    ]);

    expect(auditCount).toBe(0);
    expect(movementCount).toBe(0);
    expect(latest?.status).toBe(StockTakeStatus.CANCELED);
  });
});
