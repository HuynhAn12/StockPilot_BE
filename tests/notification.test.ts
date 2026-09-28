import { NotFoundError } from '../src/common/errors/app-error';
import { NotificationService } from '../src/modules/notifications/notification.service';

function createMockPrisma() {
  return {
    notification: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  } as any;
}

describe('NotificationService', () => {
  let prisma: any;
  let service: NotificationService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new NotificationService(prisma);
  });

  it('lists only current user notifications scoped by store and read state', async () => {
    prisma.notification.findMany.mockResolvedValue([{ id: 1, storeId: 10, userId: 20, isRead: false }]);
    prisma.notification.count.mockResolvedValue(1);

    const result = await service.list(10, 20, { isRead: false, page: 2, limit: 5 });

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { storeId: 10, userId: 20, isRead: false },
      orderBy: { createdAt: 'desc' },
      skip: 5,
      take: 5,
    });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { storeId: 10, userId: 20, isRead: false },
    });
    expect(result.pagination).toEqual({ page: 2, limit: 5, total: 1, totalPages: 1 });
  });

  it('marks one unread notification as read only after store and user ownership check', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 1, storeId: 10, userId: 20, isRead: false });
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    prisma.notification.findFirstOrThrow.mockResolvedValue({ id: 1, isRead: true, readAt: new Date() });

    await service.markRead(10, 20, 1);

    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: 1, storeId: 10, userId: 20 },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 1, storeId: 10, userId: 20, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
    expect(prisma.notification.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 1, storeId: 10, userId: 20 },
    });
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('returns already-read notifications without rewriting readAt', async () => {
    const readAt = new Date('2026-01-01T00:00:00.000Z');
    prisma.notification.findFirst.mockResolvedValue({ id: 1, storeId: 10, userId: 20, isRead: true, readAt });

    const result = await service.markRead(10, 20, 1);

    expect(result.readAt).toBe(readAt);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('rejects marking a missing or foreign notification as read', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(service.markRead(10, 20, 99)).rejects.toThrow(NotFoundError);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('marks all unread notifications for the current user only', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    const result = await service.markAllRead(10, 20);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { storeId: 10, userId: 20, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
    expect(result).toEqual({ updatedCount: 3 });
  });
});
