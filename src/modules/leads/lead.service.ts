import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { AdminAlertService } from '../../common/services/admin-alert.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { buildPaginationResult } from '../../common/utils/pagination';
import { CreateLeadInput } from '../public/public.schema';
import { AddLeadNoteInput, LEAD_STATUSES, LeadListQuery, UpdateLeadInput } from './lead.schema';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Statuses still being worked on; a new submission with the same phone is merged into these. */
const OPEN_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED'];
const CONTACT_NOTE_TYPES = ['CALL', 'EMAIL', 'MEETING'];
const STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'Mới',
  CONTACTED: 'Đã liên hệ',
  CONVERTED: 'Đã chuyển đổi',
  REJECTED: 'Không phù hợp',
};

const leadInclude = {
  assignee: { select: { id: true, fullName: true } },
  _count: { select: { notes: true } },
  notes: {
    take: 1,
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.ContactLeadInclude;

/** Keeps digits only and maps +84 to 0 so "+84 912 345 678" and "0912345678" are the same lead. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('84') && digits.length >= 11 ? `0${digits.slice(2)}` : digits;
}

export class LeadService {
  // ---------------------------------------------------------------------------
  // Public form
  // ---------------------------------------------------------------------------

  /**
   * Saves a landing-page consultation request. A repeat request from the same phone while the
   * previous one is still open is merged into it instead of creating a duplicate.
   */
  async submit(input: CreateLeadInput) {
    const phone = normalizePhone(input.phone);
    if (phone.length < 9 || phone.length > 11) {
      throw new ValidationError('Số điện thoại không hợp lệ');
    }
    const note = input.note?.trim() || null;
    const now = new Date();

    const existing = await prisma.contactLead.findFirst({
      where: { phone, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      const merged = await prisma.$transaction(async (tx) => {
        const updated = await tx.contactLead.update({
          where: { id: existing.id },
          data: {
            submissionCount: { increment: 1 },
            lastSubmittedAt: now,
            email: existing.email ?? (input.email || null),
            storeName: existing.storeName ?? (input.storeName || null),
            industry: existing.industry ?? (input.industry || null),
          },
        });
        await tx.contactLeadNote.create({
          data: {
            leadId: existing.id,
            type: 'RESUBMIT',
            body: note ? `Khách gửi lại form. Ghi chú mới: ${note}` : 'Khách gửi lại form đăng ký tư vấn.',
          },
        });
        return updated;
      });
      AdminAlertService.notify(`Khách gửi lại yêu cầu tư vấn: ${merged.fullName}`, [
        `${merged.fullName} (${merged.phone}) vừa gửi lại form, lần thứ ${merged.submissionCount}.`,
        `Trạng thái hiện tại: ${STATUS_LABELS[merged.status as LeadStatus] ?? merged.status}.`,
      ], `/admin/leads?lead=${merged.id}`);
      return { id: merged.id, fullName: merged.fullName, createdAt: merged.createdAt };
    }

    const lead = await prisma.contactLead.create({
      data: {
        fullName: input.fullName,
        phone,
        email: input.email || null,
        storeName: input.storeName || null,
        industry: input.industry || null,
        note,
        lastSubmittedAt: now,
      },
    });
    AdminAlertService.notify(`Khách tiềm năng mới: ${lead.fullName}`, [
      `Họ tên: ${lead.fullName}`,
      `Điện thoại: ${lead.phone}`,
      lead.storeName ? `Cửa hàng: ${lead.storeName}` : '',
      lead.industry ? `Ngành hàng: ${lead.industry}` : '',
      lead.note ? `Ghi chú: ${lead.note}` : '',
    ].filter(Boolean), `/admin/leads?lead=${lead.id}`);

    return { id: lead.id, fullName: lead.fullName, createdAt: lead.createdAt };
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async list(query: LeadListQuery) {
    const { page, limit } = query;
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where: Prisma.ContactLeadWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.overdue ? { status: 'NEW', lastSubmittedAt: { lt: dayAgo } } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : query.unassigned ? { assigneeId: null } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search } },
              { phone: { contains: normalizePhone(query.search) || query.search } },
              { email: { contains: query.search } },
              { storeName: { contains: query.search } },
            ],
          }
        : {}),
    };

    const [items, total, byStatus, waitingOver24h] = await Promise.all([
      prisma.contactLead.findMany({
        where,
        include: leadInclude,
        // Newest activity first, so a returning lead jumps back to the top.
        orderBy: [{ lastSubmittedAt: query.order }, { id: query.order }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.contactLead.count({ where }),
      prisma.contactLead.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.contactLead.count({ where: { status: 'NEW', lastSubmittedAt: { lt: dayAgo } } }),
    ]);

    const counts: Record<string, number> = { NEW: 0, CONTACTED: 0, CONVERTED: 0, REJECTED: 0 };
    for (const row of byStatus) counts[row.status] = row._count._all;
    const summary = { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0), waitingOver24h };

    return { ...buildPaginationResult(items, total, page, limit), summary };
  }

  async get(leadId: number) {
    const lead = await prisma.contactLead.findUnique({
      where: { id: leadId },
      include: {
        ...leadInclude,
        notes: {
          orderBy: { createdAt: 'desc' },
          include: { author: { select: { id: true, fullName: true } } },
        },
      },
    });
    if (!lead) throw new NotFoundError('Không tìm thấy khách hàng tiềm năng');
    return lead;
  }

  async update(leadId: number, input: UpdateLeadInput, actorUserId: number, meta: RequestMeta = {}) {
    const existing = await prisma.contactLead.findUnique({ where: { id: leadId } });
    if (!existing) throw new NotFoundError('Không tìm thấy khách hàng tiềm năng');

    if (input.assigneeId) {
      const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId }, select: { role: true, isActive: true } });
      if (!assignee || assignee.role !== 'ADMIN' || !assignee.isActive) {
        throw new ValidationError('Chỉ giao được cho quản trị viên đang hoạt động');
      }
    }

    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const assigneeChanged = input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId;
    if (!statusChanged && !assigneeChanged) return this.get(leadId);

    await prisma.$transaction(async (tx) => {
      const updated = await tx.contactLead.update({
        where: { id: leadId },
        data: {
          ...(statusChanged ? { status: input.status } : {}),
          ...(assigneeChanged ? { assigneeId: input.assigneeId } : {}),
        },
        include: { assignee: { select: { fullName: true } } },
      });

      if (statusChanged) {
        await tx.contactLeadNote.create({
          data: {
            leadId,
            authorId: actorUserId,
            type: 'STATUS',
            body: `Đổi trạng thái: ${STATUS_LABELS[existing.status as LeadStatus] ?? existing.status} → ${STATUS_LABELS[input.status!]}`,
          },
        });
      }
      if (assigneeChanged) {
        await tx.contactLeadNote.create({
          data: {
            leadId,
            authorId: actorUserId,
            type: 'STATUS',
            body: updated.assignee ? `Giao cho ${updated.assignee.fullName}` : 'Bỏ người phụ trách',
          },
        });
      }

      await AuditLogService.create(tx, {
        storeId: null,
        userId: actorUserId,
        action: statusChanged ? 'LEAD_STATUS_UPDATED' : 'LEAD_ASSIGNED',
        entityType: 'CONTACT_LEAD',
        entityId: leadId,
        beforeJson: { status: existing.status, assigneeId: existing.assigneeId },
        afterJson: { status: updated.status, assigneeId: updated.assigneeId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });

    return this.get(leadId);
  }

  /** Logs a care activity. Logging a call/email/meeting on a NEW lead moves it to CONTACTED. */
  async addNote(leadId: number, input: AddLeadNoteInput, actorUserId: number) {
    const existing = await prisma.contactLead.findUnique({ where: { id: leadId }, select: { id: true, status: true } });
    if (!existing) throw new NotFoundError('Không tìm thấy khách hàng tiềm năng');

    const isContact = CONTACT_NOTE_TYPES.includes(input.type);
    const promote = isContact && existing.status === 'NEW';

    await prisma.$transaction(async (tx) => {
      await tx.contactLeadNote.create({ data: { leadId, authorId: actorUserId, type: input.type, body: input.body } });
      if (isContact) {
        await tx.contactLead.update({
          where: { id: leadId },
          data: { lastContactedAt: new Date(), ...(promote ? { status: 'CONTACTED' } : {}) },
        });
      }
      if (promote) {
        await tx.contactLeadNote.create({
          data: { leadId, authorId: actorUserId, type: 'STATUS', body: 'Đổi trạng thái: Mới → Đã liên hệ' },
        });
      }
    });

    return this.get(leadId);
  }
}
