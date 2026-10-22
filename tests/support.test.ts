import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    store: { findUnique: jest.fn(), findFirst: jest.fn() },
    supportTicket: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    supportTicketMessage: { create: jest.fn() },
    supportTicketAttachment: { findUnique: jest.fn() },
    storePaymentConfig: { findFirst: jest.fn() },
    importJob: { findMany: jest.fn() },
    notification: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

const db = prisma as any;

const users: Record<number, any> = {
  1: { id: 1, email: 'owner@a.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
  2: { id: 2, email: 'staff@a.test', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null, isActive: true, store: null },
  4: { id: 4, email: 'owner@b.test', role: 'SHOP_OWNER', storeId: 2, isActive: true, store: { isActive: true } },
};

const token = (id: number) =>
  generateAccessToken({ userId: id, email: users[id].email, role: users[id].role, storeId: users[id].storeId });
const auth = (id: number) => ({ Authorization: `Bearer ${token(id)}` });

describe('Support tickets', () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(users[where.id] ?? null));
    db.auditLog.create.mockResolvedValue({ id: 1n });
  });

  describe('store side', () => {
    it('creates a ticket with its first message for the caller store only', async () => {
      db.supportTicket.create.mockResolvedValue({ id: 10, storeId: 1, category: 'DATA_IMPORT' });

      const res = await request(app)
        .post('/api/v1/support/tickets')
        .set(auth(1))
        .send({ subject: 'Cần nhập dữ liệu từ KiotViet', category: 'DATA_IMPORT', message: 'File có 500 sản phẩm' });

      expect(res.status).toBe(201);
      expect(db.supportTicket.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ storeId: 1, createdById: 1, lastStoreMessageAt: expect.any(Date) }),
      });
      expect(db.supportTicketMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ticketId: 10, authorId: 1, body: 'File có 500 sản phẩm', attachments: { create: [] } }),
      });
    });

    it('ignores a storeId sent by the client', async () => {
      const res = await request(app)
        .post('/api/v1/support/tickets')
        .set(auth(1))
        .send({ subject: 'Hỏi về thanh toán', category: 'PAYMENT', message: 'Xin chào', storeId: 2 });

      expect(res.status).toBe(400);
      expect(db.supportTicket.create).not.toHaveBeenCalled();
    });

    it('lets warehouse staff open tickets too', async () => {
      db.supportTicket.create.mockResolvedValue({ id: 11, storeId: 1, category: 'BUG' });

      const res = await request(app)
        .post('/api/v1/support/tickets')
        .set(auth(2))
        .send({ subject: 'Máy quét mã vạch lỗi', category: 'BUG', message: 'Không quét được' });

      expect(res.status).toBe(201);
    });

    it('only finds tickets inside the caller store', async () => {
      db.supportTicket.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/v1/support/tickets/10').set(auth(4));

      expect(res.status).toBe(404);
      expect(db.supportTicket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 10, storeId: 2 } }));
    });

    it('never returns internal notes and hides admin names', async () => {
      db.supportTicket.findFirst.mockResolvedValue({
        id: 10,
        storeId: 1,
        messages: [
          { id: 1, body: 'Xin hỗ trợ', fromAdmin: false, author: { id: 1, fullName: 'Owner A' } },
          { id: 2, body: 'Đã xử lý', fromAdmin: true, author: { id: 3, fullName: 'Lê Quản Trị' } },
        ],
      });

      const res = await request(app).get('/api/v1/support/tickets/10').set(auth(1));

      expect(res.status).toBe(200);
      expect(db.supportTicket.findFirst.mock.calls[0][0].include.messages.where).toEqual({ isInternal: false });
      expect(res.body.data.messages[1].author).toEqual({ id: null, fullName: 'Đội hỗ trợ StockPilot' });
      expect(JSON.stringify(res.body)).not.toContain('Lê Quản Trị');
    });

    it('reopens a resolved ticket when the store replies', async () => {
      db.supportTicket.findFirst.mockResolvedValue({ id: 10, status: 'RESOLVED', subject: 'x', store: { name: 'Store A' } });
      db.supportTicketMessage.create.mockResolvedValue({ id: 5 });

      const res = await request(app).post('/api/v1/support/tickets/10/messages').set(auth(1)).send({ body: 'Vẫn còn lỗi' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('OPEN');
      expect(db.supportTicket.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: expect.objectContaining({ status: 'OPEN', resolvedAt: null, lastStoreMessageAt: expect.any(Date) }),
      });
    });

    it('does not let admins use the store endpoints', async () => {
      const res = await request(app).get('/api/v1/support/tickets').set(auth(3));

      expect(res.status).toBe(403);
    });
  });

  describe('admin side', () => {
    it('rejects shop owners', async () => {
      const res = await request(app).get('/api/v1/admin/support/tickets').set(auth(1));

      expect(res.status).toBe(403);
    });

    it('lists tickets with status counters', async () => {
      db.supportTicket.findMany.mockResolvedValue([{ id: 10 }]);
      db.supportTicket.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      db.supportTicket.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: { _all: 2 } },
        { status: 'RESOLVED', _count: { _all: 5 } },
      ]);

      const res = await request(app).get('/api/v1/admin/support/tickets?status=ACTIVE').set(auth(3));

      expect(res.status).toBe(200);
      expect(db.supportTicket.findMany.mock.calls[0][0].where).toEqual({ status: { not: 'RESOLVED' } });
      expect(res.body.summary).toEqual({ OPEN: 2, IN_PROGRESS: 0, WAITING_STORE: 0, RESOLVED: 5, unanswered: 2, unread: 0 });
    });

    it('a public reply hands the ticket back to the store and notifies the requester', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, status: 'OPEN', subject: 'KiotViet', createdById: 1, firstResponseAt: null });
      db.supportTicketMessage.create.mockResolvedValue({ id: 7 });

      const res = await request(app).post('/api/v1/admin/support/tickets/10/messages').set(auth(3)).send({ body: 'Bạn gửi file giúp mình' });

      expect(res.status).toBe(201);
      expect(db.supportTicket.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: expect.objectContaining({ status: 'WAITING_STORE', firstResponseAt: expect.any(Date) }),
      });
      expect(db.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ storeId: 1, userId: 1, entityType: 'SUPPORT_TICKET', entityId: '10' }),
      });
    });

    it('an internal note changes nothing the store can see', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, status: 'OPEN', subject: 'x', createdById: 1, firstResponseAt: null });
      db.supportTicketMessage.create.mockResolvedValue({ id: 8 });

      await request(app)
        .post('/api/v1/admin/support/tickets/10/messages')
        .set(auth(3))
        .send({ body: 'Khách hàng VIP, ưu tiên', isInternal: true });

      expect(db.supportTicketMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isInternal: true, fromAdmin: true }) })
      );
      expect(db.supportTicket.update).not.toHaveBeenCalled();
      expect(db.notification.create).not.toHaveBeenCalled();
    });

    it('resolving records resolvedAt and an audit entry', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, status: 'IN_PROGRESS', priority: 'NORMAL', assigneeId: null });
      db.supportTicket.update.mockResolvedValue({ id: 10, status: 'RESOLVED', priority: 'NORMAL', assigneeId: null });

      const res = await request(app).patch('/api/v1/admin/support/tickets/10').set(auth(3)).send({ status: 'RESOLVED' });

      expect(res.status).toBe(200);
      expect(db.supportTicket.update.mock.calls[0][0].data).toEqual({ status: 'RESOLVED', resolvedAt: expect.any(Date) });
      expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SUPPORT_TICKET_UPDATED', storeId: 1 }) });
    });

    it('only assigns tickets to active admins', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, status: 'OPEN', priority: 'NORMAL', assigneeId: null });

      const res = await request(app).patch('/api/v1/admin/support/tickets/10').set(auth(3)).send({ assigneeId: 1 });

      expect(res.status).toBe(400);
      expect(db.supportTicket.update).not.toHaveBeenCalled();
    });

    it('includes store payment and import context for data-import tickets', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, messages: [] });
      db.storePaymentConfig.findFirst.mockResolvedValue(null);
      db.importJob.findMany.mockResolvedValue([{ id: 'job-1', type: 'PRODUCTS', status: 'COMMITTED' }]);

      const res = await request(app).get('/api/v1/admin/support/tickets/10').set(auth(3));

      expect(res.body.data.storeContext).toEqual({ payos: 'NOT_CONFIGURED', recentImports: [expect.objectContaining({ id: 'job-1' })] });
    });
  });
describe('attachments and read state', () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    it('stores real images sent with a reply, typed from their bytes', async () => {
      db.supportTicket.findFirst.mockResolvedValue({ id: 10, status: 'OPEN', subject: 'x', store: { name: 'Store A' } });
      db.supportTicketMessage.create.mockResolvedValue({ id: 6, attachments: [] });

      const res = await request(app)
        .post('/api/v1/support/tickets/10/messages')
        .set(auth(1))
        .field('body', '')
        .attach('files', PNG, { filename: 'loi.png', contentType: 'image/png' });

      expect(res.status).toBe(201);
      const data = db.supportTicketMessage.create.mock.calls[0][0].data;
      expect(data.attachments.create).toEqual([
        expect.objectContaining({ ticketId: 10, fileName: 'loi.png', mimeType: 'image/png', size: PNG.length }),
      ]);
    });

    it('rejects a file that only pretends to be an image', async () => {
      db.supportTicket.findFirst.mockResolvedValue({ id: 10, status: 'OPEN', subject: 'x', store: { name: 'Store A' } });

      const res = await request(app)
        .post('/api/v1/support/tickets/10/messages')
        .set(auth(1))
        .field('body', 'xem file')
        .attach('files', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
      expect(db.supportTicketMessage.create).not.toHaveBeenCalled();
    });

    it('rejects an empty reply without images', async () => {
      const res = await request(app).post('/api/v1/support/tickets/10/messages').set(auth(1)).send({ body: '   ' });

      expect(res.status).toBe(400);
    });

    it('rejects more than 3 images', async () => {
      let req = request(app).post('/api/v1/support/tickets/10/messages').set(auth(1)).field('body', 'nhiều ảnh');
      for (let i = 0; i < 4; i += 1) req = req.attach('files', PNG, { filename: `a${i}.png`, contentType: 'image/png' });

      const res = await req;

      expect(res.status).toBe(400);
    });

    it('serves an attachment only to its own store and never from internal notes', async () => {
      db.supportTicketAttachment.findUnique.mockResolvedValue({
        id: 3, fileName: 'loi.png', mimeType: 'image/png', data: PNG, message: { isInternal: false, ticket: { storeId: 1 } },
      });

      const own = await request(app).get('/api/v1/support/attachments/3').set(auth(1));
      expect(own.status).toBe(200);
      expect(own.headers['content-type']).toBe('image/png');
      expect(own.headers['x-content-type-options']).toBe('nosniff');

      const other = await request(app).get('/api/v1/support/attachments/3').set(auth(4));
      expect(other.status).toBe(404);

      db.supportTicketAttachment.findUnique.mockResolvedValue({
        id: 4, fileName: 'noi-bo.png', mimeType: 'image/png', data: PNG, message: { isInternal: true, ticket: { storeId: 1 } },
      });
      const internal = await request(app).get('/api/v1/support/attachments/4').set(auth(1));
      expect(internal.status).toBe(404);
    });

    it('flags tickets with unseen support replies and marks them read when opened', async () => {
      const replied = new Date('2026-10-22T10:00:00Z');
      db.supportTicket.findMany.mockResolvedValue([
        { id: 10, lastAdminMessageAt: replied, storeReadAt: new Date('2026-10-22T09:00:00Z') },
        { id: 11, lastAdminMessageAt: replied, storeReadAt: new Date('2026-10-22T11:00:00Z') },
      ]);
      db.supportTicket.count.mockResolvedValue(2);

      const list = await request(app).get('/api/v1/support/tickets').set(auth(1));
      expect(list.body.data.map((t: any) => t.unread)).toEqual([true, false]);

      const count = await request(app).get('/api/v1/support/unread-count').set(auth(1));
      expect(count.body.data).toEqual({ unread: 1 });

      db.supportTicket.findFirst.mockResolvedValue({
        id: 10, storeId: 1, lastAdminMessageAt: replied, storeReadAt: null, messages: [],
      });
      await request(app).get('/api/v1/support/tickets/10').set(auth(1));
      expect(db.supportTicket.update).toHaveBeenCalledWith({ where: { id: 10 }, data: { storeReadAt: expect.any(Date) } });
    });

    it('a public admin reply records the admin message time for the store unread badge', async () => {
      db.supportTicket.findUnique.mockResolvedValue({ id: 10, storeId: 1, status: 'OPEN', subject: 'x', createdById: 1, firstResponseAt: null });
      db.supportTicketMessage.create.mockResolvedValue({ id: 9 });

      await request(app).post('/api/v1/admin/support/tickets/10/messages').set(auth(3)).field('body', 'Đã kiểm tra').field('isInternal', 'false');

      expect(db.supportTicket.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: expect.objectContaining({ lastAdminMessageAt: expect.any(Date), status: 'WAITING_STORE' }),
      });
    });
  });
});

describe('Support ticket filters', () => {
  const app = createApp();
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(users[where.id] ?? null));
    db.supportTicket.findMany.mockResolvedValue([]);
    db.supportTicket.count.mockResolvedValue(0);
    db.supportTicket.groupBy.mockResolvedValue([]);
  });

  it('filters by priority', async () => {
    const res = await request(app).get('/api/v1/admin/support/tickets?priority=HIGH&status=ACTIVE').set(auth(3));
    expect(res.status).toBe(200);
    expect(db.supportTicket.findMany.mock.calls[0][0].where).toEqual({ status: { not: 'RESOLVED' }, priority: 'HIGH' });
  });

  it('filters by assignee or unassigned tickets', async () => {
    await request(app).get('/api/v1/admin/support/tickets?assigneeId=3').set(auth(3));
    expect(db.supportTicket.findMany.mock.calls[0][0].where).toEqual({ assigneeId: 3 });

    db.supportTicket.findMany.mockClear();
    await request(app).get('/api/v1/admin/support/tickets?unassigned=true').set(auth(3));
    expect(db.supportTicket.findMany.mock.calls[0][0].where).toEqual({ assigneeId: null });
  });
});
