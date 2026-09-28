import { PrismaClient } from '@prisma/client';
import { NotificationService } from '../../src/modules/notifications/notification.service';

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

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Notification Center integration', () => {
  let prisma: PrismaClient;
  let service: NotificationService;
  let storeId: number;
  let otherStoreId: number;
  let userId: number;
  let otherUserId: number;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    service = new NotificationService(prisma);

    const store = await prisma.store.create({
      data: { name: `Notification Store ${suffix}`, code: `NOTIF_STORE_${suffix}` },
    });
    storeId = store.id;

    const otherStore = await prisma.store.create({
      data: { name: `Other Notification Store ${suffix}`, code: `OTHER_NOTIF_STORE_${suffix}` },
    });
    otherStoreId = otherStore.id;

    const user = await prisma.user.create({
      data: {
        email: `notification-${suffix}@example.com`,
        passwordHash: 'hashed-password',
        fullName: 'Notification Tester',
        role: 'SHOP_OWNER',
        storeId,
      },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: {
        email: `other-notification-${suffix}@example.com`,
        passwordHash: 'hashed-password',
        fullName: 'Other Notification Tester',
        role: 'SHOP_OWNER',
        storeId: otherStoreId,
      },
    });
    otherUserId = otherUser.id;
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
  });

  afterAll(async () => {
    if (storeId) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    if (otherStoreId) {
      await prisma.store.delete({ where: { id: otherStoreId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('lists only notifications owned by the current user and excludes store-wide rows', async () => {
    await prisma.notification.createMany({
      data: [
        {
          storeId,
          userId,
          type: 'TEST',
          title: 'Current user unread',
          message: 'Visible',
        },
        {
          storeId,
          userId,
          type: 'TEST',
          title: 'Current user read',
          message: 'Visible when no unread filter',
          isRead: true,
          readAt: new Date(),
        },
        {
          storeId,
          userId: null,
          type: 'TEST',
          title: 'Store-wide',
          message: 'Not visible in minimal per-user inbox',
        },
        {
          storeId: otherStoreId,
          userId: otherUserId,
          type: 'TEST',
          title: 'Other store',
          message: 'Not visible',
        },
      ],
    });

    const unread = await service.list(storeId, userId, { isRead: false, page: 1, limit: 10 });
    const all = await service.list(storeId, userId, { page: 1, limit: 10 });

    expect(unread.items).toHaveLength(1);
    expect(unread.items[0].title).toBe('Current user unread');
    expect(all.items.map((item) => item.title).sort()).toEqual(['Current user read', 'Current user unread']);
  });

  it('marks one current-user notification as read and rejects foreign notifications', async () => {
    const own = await prisma.notification.create({
      data: { storeId, userId, type: 'TEST', title: 'Own', message: 'Own notification' },
    });
    const foreign = await prisma.notification.create({
      data: {
        storeId: otherStoreId,
        userId: otherUserId,
        type: 'TEST',
        title: 'Foreign',
        message: 'Foreign notification',
      },
    });

    const updated = await service.markRead(storeId, userId, own.id);

    await expect(service.markRead(storeId, userId, foreign.id)).rejects.toThrow();
    expect(updated.isRead).toBe(true);
    expect(updated.readAt).toBeTruthy();
  });

  it('marks all unread notifications for only the current user', async () => {
    await prisma.notification.createMany({
      data: [
        { storeId, userId, type: 'TEST', title: 'One', message: 'One' },
        { storeId, userId, type: 'TEST', title: 'Two', message: 'Two' },
        { storeId, userId: null, type: 'TEST', title: 'Broadcast', message: 'Broadcast' },
        { storeId: otherStoreId, userId: otherUserId, type: 'TEST', title: 'Other', message: 'Other' },
      ],
    });

    const result = await service.markAllRead(storeId, userId);
    const ownUnread = await prisma.notification.count({ where: { storeId, userId, isRead: false } });
    const broadcast = await prisma.notification.findFirstOrThrow({ where: { storeId, userId: null } });
    const otherStoreUnread = await prisma.notification.count({
      where: { storeId: otherStoreId, userId: otherUserId, isRead: false },
    });

    expect(result.updatedCount).toBe(2);
    expect(ownUnread).toBe(0);
    expect(broadcast.isRead).toBe(false);
    expect(otherStoreUnread).toBe(1);
  });
});
