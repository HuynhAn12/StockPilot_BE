import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';
import { normalizePhone } from '../src/modules/leads/lead.service';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    store: { findUnique: jest.fn(), findFirst: jest.fn() },
    contactLead: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    contactLeadNote: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

const db = prisma as any;
const users: Record<number, any> = {
  1: { id: 1, email: 'owner@a.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
  3: { id: 3, email: 'admin@stockpilot.test', fullName: 'Admin', role: 'ADMIN', storeId: null, isActive: true, store: null },
  4: { id: 4, email: 'ops@stockpilot.test', fullName: 'Ops', role: 'ADMIN', storeId: null, isActive: true, store: null },
};
const auth = (id: number) => ({
  Authorization: `Bearer ${generateAccessToken({ userId: id, email: users[id].email, role: users[id].role, storeId: users[id].storeId })}`,
});
const lead = (over: Record<string, unknown> = {}) => ({
  id: 5,
  fullName: 'Phạm Minh Tuấn',
  phone: '0912345678',
  email: null,
  storeName: null,
  industry: null,
  note: null,
  status: 'NEW',
  assigneeId: null,
  submissionCount: 1,
  createdAt: new Date(),
  notes: [],
  ...over,
});

describe('Contact leads', () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(users[where.id] ?? null));
    db.auditLog.create.mockResolvedValue({ id: 1n });
    db.contactLead.findUnique.mockResolvedValue(lead());
  });

  describe('public form', () => {
    const form = { fullName: 'Phạm Minh Tuấn', phone: '+84 912 345 678', storeName: 'Tuấn Beauty', note: 'Cần 2 chi nhánh' };

    it('normalizes Vietnamese phone formats', () => {
      expect(normalizePhone('+84 912 345 678')).toBe('0912345678');
      expect(normalizePhone('0912.345.678')).toBe('0912345678');
      expect(normalizePhone('84912345678')).toBe('0912345678');
    });

    it('creates a new lead with the normalized phone', async () => {
      db.contactLead.findFirst.mockResolvedValue(null);
      db.contactLead.create.mockResolvedValue(lead({ storeName: 'Tuấn Beauty' }));

      const res = await request(app).post('/api/v1/public/leads').send(form);

      expect(res.status).toBe(201);
      expect(db.contactLead.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '0912345678', storeName: 'Tuấn Beauty', note: 'Cần 2 chi nhánh' }),
      });
    });

    it('merges a repeat submission from the same phone into the open lead', async () => {
      db.contactLead.findFirst.mockResolvedValue(lead({ status: 'CONTACTED' }));
      db.contactLead.update.mockResolvedValue(lead({ status: 'CONTACTED', submissionCount: 2 }));

      const res = await request(app).post('/api/v1/public/leads').send(form);

      expect(res.status).toBe(201);
      expect(db.contactLead.create).not.toHaveBeenCalled();
      expect(db.contactLead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: '0912345678', status: { in: ['NEW', 'CONTACTED'] } } })
      );
      expect(db.contactLead.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 5 }, data: expect.objectContaining({ submissionCount: { increment: 1 } }) })
      );
      expect(db.contactLeadNote.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ leadId: 5, type: 'RESUBMIT', body: expect.stringContaining('Cần 2 chi nhánh') }),
      });
    });

    it('silently drops submissions that fill the hidden honeypot field', async () => {
      const res = await request(app).post('/api/v1/public/leads').send({ ...form, website: 'http://spam.example' });

      expect(res.status).toBe(201);
      expect(db.contactLead.findFirst).not.toHaveBeenCalled();
      expect(db.contactLead.create).not.toHaveBeenCalled();
    });
  });

  describe('admin', () => {
    it('lists leads with counts for every status, not only the filtered page', async () => {
      db.contactLead.findMany.mockResolvedValue([lead()]);
      db.contactLead.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      db.contactLead.groupBy.mockResolvedValue([
        { status: 'NEW', _count: { _all: 3 } },
        { status: 'CONVERTED', _count: { _all: 4 } },
      ]);

      const res = await request(app).get('/api/v1/admin/leads?status=NEW').set(auth(3));

      expect(res.status).toBe(200);
      expect(db.contactLead.findMany.mock.calls[0][0].where).toEqual({ status: 'NEW' });
      expect(res.body.summary).toEqual({ NEW: 3, CONTACTED: 0, CONVERTED: 4, REJECTED: 0, total: 7, waitingOver24h: 2 });
    });

    it('rejects shop owners', async () => {
      const res = await request(app).get('/api/v1/admin/leads').set(auth(1));
      expect(res.status).toBe(403);
    });

    it('rejects an unknown lead status', async () => {
      const res = await request(app).patch('/api/v1/admin/leads/5/status').set(auth(3)).send({ status: 'WON' });
      expect(res.status).toBe(400);
    });

    it('keeps the legacy status endpoint and logs the change in the care history and audit log', async () => {
      db.contactLead.update.mockResolvedValue(lead({ status: 'CONTACTED', assignee: null }));

      const res = await request(app).patch('/api/v1/admin/leads/5/status').set(auth(3)).send({ status: 'CONTACTED' });

      expect(res.status).toBe(200);
      expect(db.contactLeadNote.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ leadId: 5, type: 'STATUS', body: 'Đổi trạng thái: Mới → Đã liên hệ' }),
      });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'LEAD_STATUS_UPDATED', entityType: 'CONTACT_LEAD', entityId: '5' }),
      });
    });

    it('assigns a lead only to an active admin', async () => {
      const bad = await request(app).patch('/api/v1/admin/leads/5').set(auth(3)).send({ assigneeId: 1 });
      expect(bad.status).toBe(400);

      db.contactLead.update.mockResolvedValue(lead({ assigneeId: 4, assignee: { fullName: 'Ops' } }));
      const ok = await request(app).patch('/api/v1/admin/leads/5').set(auth(3)).send({ assigneeId: 4 });
      expect(ok.status).toBe(200);
      expect(db.contactLeadNote.create).toHaveBeenCalledWith({ data: expect.objectContaining({ body: 'Giao cho Ops' }) });
    });

    it('logging a call on a NEW lead records contact time and moves it to CONTACTED', async () => {
      const res = await request(app).post('/api/v1/admin/leads/5/notes').set(auth(3)).send({ type: 'CALL', body: 'Đã gọi, hẹn demo thứ 6' });

      expect(res.status).toBe(201);
      expect(db.contactLeadNote.create).toHaveBeenCalledWith({
        data: { leadId: 5, authorId: 3, type: 'CALL', body: 'Đã gọi, hẹn demo thứ 6' },
      });
      expect(db.contactLead.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { lastContactedAt: expect.any(Date), status: 'CONTACTED' },
      });
    });

    it('a plain note does not change status or contact time', async () => {
      await request(app).post('/api/v1/admin/leads/5/notes').set(auth(3)).send({ type: 'NOTE', body: 'Khách quan tâm gói 2 chi nhánh' });

      expect(db.contactLead.update).not.toHaveBeenCalled();
    });
  });
});

describe('Contact lead filters', () => {
  const app = createApp();
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(users[where.id] ?? null));
    db.contactLead.findMany.mockResolvedValue([]);
    db.contactLead.count.mockResolvedValue(0);
    db.contactLead.groupBy.mockResolvedValue([]);
  });

  it('filters overdue leads (NEW, last submitted more than 24 hours ago)', async () => {
    await request(app).get('/api/v1/admin/leads?overdue=true').set(auth(3));
    expect(db.contactLead.findMany.mock.calls[0][0].where).toEqual({ status: 'NEW', lastSubmittedAt: { lt: expect.any(Date) } });
  });

  it('filters unassigned leads', async () => {
    await request(app).get('/api/v1/admin/leads?unassigned=true').set(auth(3));
    expect(db.contactLead.findMany.mock.calls[0][0].where).toEqual({ assigneeId: null });
  });
});
