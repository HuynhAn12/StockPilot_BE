import { Prisma, SupportTicketStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { AdminAlertService } from '../../common/services/admin-alert.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { buildPaginationResult } from '../../common/utils/pagination';
import {
  AdminReplyInput,
  AdminTicketListQuery,
  AdminUpdateTicketInput,
  CreateTicketInput,
  StoreTicketListQuery,
} from './support.schema';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Uploaded image as received from multer (memory storage). */
export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Detects the real image type from the file's first bytes; the browser-reported MIME type is not trusted. */
export function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function requireContent(body: string, files: IncomingFile[]) {
  if (!body.trim() && files.length === 0) throw new ValidationError('Nhập nội dung hoặc đính kèm ảnh');
}

function toAttachmentRows(files: IncomingFile[] = []) {
  if (files.length > MAX_ATTACHMENTS) {
    throw new ValidationError(`Tối đa ${MAX_ATTACHMENTS} ảnh mỗi tin nhắn`);
  }
  return files.map((file) => {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new ValidationError('Mỗi ảnh tối đa 5 MB');
    const mimeType = sniffImageType(file.buffer);
    if (!mimeType) throw new ValidationError(`"${file.originalname}" không phải ảnh JPG, PNG, WEBP hoặc GIF`);
    return {
      fileName: file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200) || 'anh',
      mimeType,
      size: file.size,
      data: file.buffer,
    };
  });
}

const attachmentMetaSelect = { id: true, fileName: true, mimeType: true, size: true } satisfies Prisma.SupportTicketAttachmentSelect;
const personSelect = { id: true, fullName: true, email: true, role: true } satisfies Prisma.UserSelect;

const ticketListInclude = {
  store: { select: { id: true, name: true, code: true, isActive: true } },
  createdBy: { select: personSelect },
  assignee: { select: { id: true, fullName: true } },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketInclude;

function isAfter(a: Date | null, b: Date | null) {
  return Boolean(a && (!b || a > b));
}

/** Store side: unread when the support team wrote after the store last opened the ticket. */
const storeUnread = (t: { lastAdminMessageAt: Date | null; storeReadAt: Date | null }) => isAfter(t.lastAdminMessageAt, t.storeReadAt);
/** Admin side: unread when the store wrote after an admin last opened the ticket. */
const adminUnread = (t: { lastStoreMessageAt: Date | null; adminReadAt: Date | null }) => isAfter(t.lastStoreMessageAt, t.adminReadAt);

/**
 * Support tickets between stores and the platform team.
 * Store-side methods are always scoped by the caller's storeId; internal notes never leave the admin side.
 */
export class SupportService {
  // ---------------------------------------------------------------------------
  // Store side
  // ---------------------------------------------------------------------------

  async listStoreTickets(storeId: number, query: StoreTicketListQuery) {
    const where: Prisma.SupportTicketWhereInput = { storeId, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: { createdBy: { select: { id: true, fullName: true } } },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.supportTicket.count({ where }),
    ]);
    const withUnread = items.map(({ adminReadAt: _a, lastStoreMessageAt: _s, ...t }) => ({ ...t, unread: storeUnread(t) }));
    return buildPaginationResult(withUnread, total, query.page, query.limit);
  }

  async countStoreUnread(storeId: number) {
    const tickets = await prisma.supportTicket.findMany({
      where: { storeId, lastAdminMessageAt: { not: null } },
      select: { lastAdminMessageAt: true, storeReadAt: true },
    });
    return { unread: tickets.filter(storeUnread).length };
  }

  async createTicket(storeId: number, userId: number, input: CreateTicketInput, files: IncomingFile[] = []) {
    const attachments = toAttachmentRows(files);
    const now = new Date();

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: { storeId, createdById: userId, subject: input.subject, category: input.category, lastMessageAt: now, lastStoreMessageAt: now, storeReadAt: now },
      });
      await tx.supportTicketMessage.create({
        data: {
          ticketId: created.id,
          authorId: userId,
          body: input.message,
          attachments: { create: attachments.map((a) => ({ ...a, ticketId: created.id })) },
        },
      });
      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'SUPPORT_TICKET_CREATED',
        entityType: 'SUPPORT_TICKET',
        entityId: created.id,
        afterJson: { ticketId: created.id, category: created.category, attachments: attachments.length },
      });
      return created;
    });

    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } });
    AdminAlertService.notify(`Yêu cầu hỗ trợ mới #${ticket.id}: ${ticket.subject}`, [
      `Cửa hàng: ${store?.name ?? storeId}`,
      `Tiêu đề: ${ticket.subject}`,
      attachments.length ? `Kèm ${attachments.length} ảnh` : '',
    ].filter(Boolean), `/admin/support?ticket=${ticket.id}`);

    return ticket;
  }

  /** Opening a ticket marks the support team's replies as read. */
  async getStoreTicket(storeId: number, ticketId: number) {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, storeId },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            fromAdmin: true,
            createdAt: true,
            author: { select: { id: true, fullName: true } },
            attachments: { select: attachmentMetaSelect },
          },
        },
      },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }
    if (storeUnread(ticket)) {
      await prisma.supportTicket.update({ where: { id: ticketId }, data: { storeReadAt: new Date() } });
    }

    const { adminReadAt: _a, lastStoreMessageAt: _s, ...rest } = ticket;
    // Admins are shown to the store as the support team, not by personal name.
    return {
      ...rest,
      messages: ticket.messages.map((m) => ({
        ...m,
        author: m.fromAdmin ? { id: null, fullName: 'Đội hỗ trợ StockPilot' } : m.author,
      })),
    };
  }

  async replyAsStore(storeId: number, userId: number, ticketId: number, body: string, files: IncomingFile[] = []) {
    requireContent(body, files);
    const attachments = toAttachmentRows(files);
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, storeId },
      select: { id: true, status: true, subject: true, store: { select: { name: true } } },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }

    // A store reply means the ball is back with the support team; it also reopens a resolved ticket.
    const nextStatus: SupportTicketStatus =
      ticket.status === 'WAITING_STORE' || ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status;
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.supportTicketMessage.create({
        data: { ticketId, authorId: userId, body, attachments: { create: attachments.map((a) => ({ ...a, ticketId })) } },
        select: { id: true, body: true, fromAdmin: true, createdAt: true, attachments: { select: attachmentMetaSelect } },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastMessageAt: now,
          lastStoreMessageAt: now,
          storeReadAt: now,
          status: nextStatus,
          ...(nextStatus !== ticket.status ? { resolvedAt: null } : {}),
        },
      });
      return { message, status: nextStatus };
    });

    AdminAlertService.notify(`Cửa hàng trả lời yêu cầu #${ticketId}: ${ticket.subject}`, [
      `Cửa hàng: ${ticket.store.name}`,
      ticket.status === 'RESOLVED' ? 'Yêu cầu đã giải quyết nay được mở lại.' : '',
    ].filter(Boolean), `/admin/support?ticket=${ticketId}`);

    return result;
  }

  async getStoreAttachment(storeId: number, attachmentId: number) {
    const attachment = await prisma.supportTicketAttachment.findUnique({
      where: { id: attachmentId },
      include: { message: { select: { isInternal: true, ticket: { select: { storeId: true } } } } },
    });
    // Same 404 for "missing" and "belongs to another store / internal note" to avoid leaking existence.
    if (!attachment || attachment.message.ticket.storeId !== storeId || attachment.message.isInternal) {
      throw new NotFoundError('Không tìm thấy ảnh');
    }
    return attachment;
  }

  // ---------------------------------------------------------------------------
  // Admin side
  // ---------------------------------------------------------------------------

  async listAdminTickets(query: AdminTicketListQuery) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(query.status === 'ACTIVE' ? { status: { not: 'RESOLVED' } } : query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : query.unassigned ? { assigneeId: null } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.search
        ? { OR: [{ subject: { contains: query.search } }, { store: { name: { contains: query.search } } }] }
        : {}),
    };

    const [items, total, byStatus, unanswered, openTimestamps] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: ticketListInclude,
        orderBy: [{ lastMessageAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.supportTicket.count({ where: { status: 'OPEN', firstResponseAt: null } }),
      prisma.supportTicket.findMany({
        where: { status: { not: 'RESOLVED' }, lastStoreMessageAt: { not: null } },
        select: { lastStoreMessageAt: true, adminReadAt: true },
      }),
    ]);

    const counts = { OPEN: 0, IN_PROGRESS: 0, WAITING_STORE: 0, RESOLVED: 0 };
    for (const row of byStatus) counts[row.status] = row._count._all;
    const withUnread = items.map((t) => ({ ...t, unread: adminUnread(t) }));

    return {
      ...buildPaginationResult(withUnread, total, query.page, query.limit),
      summary: { ...counts, unanswered, unread: openTimestamps.filter(adminUnread).length },
    };
  }

  async getAdminTicket(ticketId: number) {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        ...ticketListInclude,
        store: { select: { id: true, name: true, code: true, phone: true, isActive: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            fromAdmin: true,
            isInternal: true,
            createdAt: true,
            author: { select: personSelect },
            attachments: { select: attachmentMetaSelect },
          },
        },
      },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }
    if (adminUnread(ticket)) {
      await prisma.supportTicket.update({ where: { id: ticketId }, data: { adminReadAt: new Date() } });
    }

    // Context that helps answer without opening the store: payment setup and recent data imports.
    const [payos, recentImports] = await Promise.all([
      prisma.storePaymentConfig.findFirst({
        where: { storeId: ticket.storeId, provider: 'PAYOS' },
        select: { isActive: true, configuredAt: true },
      }),
      prisma.importJob.findMany({
        where: { storeId: ticket.storeId },
        select: { id: true, type: true, status: true, totalRows: true, validRows: true, invalidRows: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    return { ...ticket, storeContext: { payos: payos ? (payos.isActive ? 'ACTIVE' : 'DISABLED') : 'NOT_CONFIGURED', recentImports } };
  }

  async replyAsAdmin(ticketId: number, adminId: number, input: AdminReplyInput, files: IncomingFile[] = []) {
    requireContent(input.body, files);
    const attachments = toAttachmentRows(files);
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, storeId: true, status: true, subject: true, createdById: true, firstResponseAt: true },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }

    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const message = await tx.supportTicketMessage.create({
        data: {
          ticketId,
          authorId: adminId,
          fromAdmin: true,
          isInternal: input.isInternal,
          body: input.body,
          attachments: { create: attachments.map((a) => ({ ...a, ticketId })) },
        },
        select: { id: true, body: true, fromAdmin: true, isInternal: true, createdAt: true, attachments: { select: attachmentMetaSelect } },
      });

      if (!input.isInternal) {
        // A public answer hands the ticket back to the store unless it is already resolved.
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            lastMessageAt: now,
            lastAdminMessageAt: now,
            adminReadAt: now,
            firstResponseAt: ticket.firstResponseAt ?? now,
            ...(ticket.status === 'RESOLVED' ? {} : { status: 'WAITING_STORE' }),
          },
        });

        if (ticket.createdById) {
          await tx.notification.create({
            data: {
              storeId: ticket.storeId,
              userId: ticket.createdById,
              type: 'system',
              title: 'Đội hỗ trợ đã trả lời',
              message: `Yêu cầu "${ticket.subject}" có phản hồi mới.`,
              entityType: 'SUPPORT_TICKET',
              entityId: String(ticketId),
            },
          });
        }
      }

      return message;
    });
  }

  async getAdminAttachment(attachmentId: number) {
    const attachment = await prisma.supportTicketAttachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) throw new NotFoundError('Không tìm thấy ảnh');
    return attachment;
  }

  async updateTicket(ticketId: number, input: AdminUpdateTicketInput, adminId: number, meta: RequestMeta = {}) {
    const existing = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, storeId: true, status: true, priority: true, assigneeId: true },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }

    if (input.assigneeId) {
      const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId }, select: { role: true, isActive: true } });
      if (!assignee || assignee.role !== 'ADMIN' || !assignee.isActive) {
        throw new ValidationError('Chỉ giao được cho quản trị viên đang hoạt động');
      }
    }

    const data: Prisma.SupportTicketUncheckedUpdateInput = {
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.status ? { status: input.status, resolvedAt: input.status === 'RESOLVED' ? new Date() : null } : {}),
    };

    return prisma.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({ where: { id: ticketId }, data, include: ticketListInclude });
      await AuditLogService.create(tx, {
        storeId: existing.storeId,
        userId: adminId,
        action: 'SUPPORT_TICKET_UPDATED',
        entityType: 'SUPPORT_TICKET',
        entityId: ticketId,
        beforeJson: { status: existing.status, priority: existing.priority, assigneeId: existing.assigneeId },
        afterJson: { status: updated.status, priority: updated.priority, assigneeId: updated.assigneeId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    });
  }
}
