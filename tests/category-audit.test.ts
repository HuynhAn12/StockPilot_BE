const mockPrisma: any = {
  category: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  product: {
    count: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn((callback: (tx: any) => any) => callback(mockPrisma)),
};

jest.mock('../src/config/db', () => ({ prisma: mockPrisma }));

import { CategoryService } from '../src/modules/categories/category.service';

describe('CategoryService audit logging', () => {
  let service: CategoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CategoryService();
    mockPrisma.$transaction.mockImplementation((callback: (tx: any) => any) => callback(mockPrisma));
  });

  it('creates CATEGORY_CREATED audit in the same transaction as category creation', async () => {
    mockPrisma.category.findUnique.mockResolvedValue(null);
    mockPrisma.category.create.mockResolvedValue({
      id: 10,
      storeId: 1,
      code: 'FOOD',
      name: 'Food',
      isActive: true,
    });

    await service.createCategory(1, { code: ' food ', name: ' Food ' }, 99);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.category.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ storeId: 1, code: 'FOOD', name: 'Food' }),
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 1,
        userId: 99,
        action: 'CATEGORY_CREATED',
        entityType: 'CATEGORY',
        entityId: '10',
        afterJson: {
          id: 10,
          code: 'FOOD',
          name: 'Food',
          isActive: true,
        },
      }),
    });
  });

  it('maps duplicate category code races to ConflictError without audit leakage', async () => {
    mockPrisma.category.findUnique.mockResolvedValue(null);
    mockPrisma.category.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.createCategory(1, { code: ' food ', name: ' Food ' }, 99)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Mã danh mục này đã tồn tại trong cửa hàng',
    });

    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('records CATEGORY_DEACTIVATED when an active category is disabled', async () => {
    const before = {
      id: 10,
      storeId: 1,
      code: 'FOOD',
      name: 'Food',
      isActive: true,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const after = { ...before, isActive: false, updatedAt: new Date('2026-01-01T00:00:01.000Z') };
    mockPrisma.category.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    mockPrisma.category.updateMany.mockResolvedValue({ count: 1 });

    await service.updateCategory(1, 10, { isActive: false }, 99);

    expect(mockPrisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 10, storeId: 1, updatedAt: before.updatedAt },
      data: { isActive: false },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 1,
        userId: 99,
        action: 'CATEGORY_DEACTIVATED',
        entityType: 'CATEGORY',
        entityId: '10',
        beforeJson: {
          id: 10,
          code: 'FOOD',
          name: 'Food',
          isActive: true,
        },
        afterJson: {
          id: 10,
          code: 'FOOD',
          name: 'Food',
          isActive: false,
        },
      }),
    });
  });

  it('rejects cross-store category updates without writing audit rows', async () => {
    mockPrisma.category.findFirst.mockResolvedValue(null);

    await expect(service.updateCategory(2, 10, { name: 'Other' }, 99)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Không tìm thấy danh mục trong cửa hàng của bạn',
    });

    expect(mockPrisma.category.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns a readable UTF-8 conflict message when category changed concurrently', async () => {
    const before = {
      id: 10,
      storeId: 1,
      code: 'FOOD',
      name: 'Food',
      isActive: true,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    mockPrisma.category.findFirst.mockResolvedValueOnce(before);
    mockPrisma.category.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.updateCategory(1, 10, { name: 'Changed' }, 99)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Danh mục đã thay đổi, vui lòng thử lại',
    });

    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('records CATEGORY_DELETED for supported category deletion', async () => {
    const existing = {
      id: 10,
      storeId: 1,
      code: 'FOOD',
      name: 'Food',
      isActive: true,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    mockPrisma.category.findFirst.mockResolvedValue(existing);
    mockPrisma.product.count.mockResolvedValue(0);
    mockPrisma.category.deleteMany.mockResolvedValue({ count: 1 });

    await service.deleteCategory(1, 10, 99);

    expect(mockPrisma.product.count).toHaveBeenCalledWith({ where: { storeId: 1, categoryId: 10 } });
    expect(mockPrisma.category.deleteMany).toHaveBeenCalledWith({
      where: { id: 10, storeId: 1, updatedAt: existing.updatedAt },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 1,
        userId: 99,
        action: 'CATEGORY_DELETED',
        entityType: 'CATEGORY',
        entityId: '10',
      }),
    });
  });

  it('rejects cross-store category deletes without writing audit rows', async () => {
    mockPrisma.category.findFirst.mockResolvedValue(null);

    await expect(service.deleteCategory(2, 10, 99)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Không tìm thấy danh mục trong cửa hàng của bạn',
    });

    expect(mockPrisma.category.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});
