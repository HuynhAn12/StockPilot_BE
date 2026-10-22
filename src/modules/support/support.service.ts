import { Prisma, SupportTicketStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
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

const personSelect = { id: true, fullName: true, email: true, role: true } satisfies Prisma.UserSelect;

const ticketListInclude = {
  store: { select: { id: true, name: true, code: true, isActive: true } },
  createdBy: { select: personSelect },
  assignee: { select: { id: true, fullName: true } },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketInclude;

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
        include: { createdBy: { select: { id: true, fullName: true } }, _count: { select: { messages: { where: { isInternal: false } } } } },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.supportTicket.count({ where }),
    ]);
    return buildPaginationResult(items, total, query.page, query.limit);
  }

  async createTicket(storeId: number, userId: number, input: CreateTicketInput) {
    return prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          storeId,
          createdById: userId,
          subject: input.subject,
          category: input.category,
          messages: { create: { authorId: userId, body: input.message } },
        },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'SUPPORT_TICKET_CREATED',
        entityType: 'SUPPORT_TICKET',
        entityId: ticket.id,
        afterJson: { ticketId: ticket.id, category: ticket.category },
      });

      return ticket;
    });
  }

  async getStoreTicket(storeId: number, ticketId: number) {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, storeId },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          select: { id: true, body: true, fromAdmin: true, createdAt: true, author: { select: { id: true, fullName: true } } },
        },
      },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }
    // Admins are shown to the store as the support team, not by personal name.
    return {
      ...ticket,
      messages: ticket.messages.map((m) => ({
        ...m,
        author: m.fromAdmin ? { id: null, fullName: 'Đội hỗ trợ StockPilot' } : m.author,
      })),
    };
  }

  async replyAsStore(storeId: number, userId: number, ticketId: number, body: string) {
    const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, storeId }, select: { id: true, status: true } });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
    }

    // A store reply means the ball is back with the support team; it also reopens a resolved ticket.
    const nextStatus: SupportTicketStatus =
      ticket.status === 'WAITING_STORE' || ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status;
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const message = await tx.supportTicketMessage.create({ data: { ticketId, authorId: userId, body } });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { lastMessageAt: now, status: nextStatus, ...(nextStatus !== ticket.status ? { resolvedAt: null } : {}) },
      });
      return { message, status: nextStatus };
    });
  }

  // ---------------------------------------------------------------------------
  // Admin side
  // ---------------------------------------------------------------------------

  async listAdminTickets(query: AdminTicketListQuery) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(query.status === 'ACTIVE' ? { status: { not: 'RESOLVED' } } : query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.search
        ? { OR: [{ subject: { contains: query.search } }, { store: { name: { contains: query.search } } }] }
        : {}),
    };

    const [items, total, byStatus, unanswered] = await Promise.all([
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
    ]);

    const counts = { OPEN: 0, IN_PROGRESS: 0, WAITING_STORE: 0, RESOLVED: 0 };
    for (const row of byStatus) counts[row.status] = row._count._all;

    return { ...buildPaginationResult(items, total, query.page, query.limit), summary: { ...counts, unanswered } };
  }

  async getAdminTicket(ticketId: number) {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        ...ticketListInclude,
        store: { select: { id: true, name: true, code: true, phone: true, isActive: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, body: true, fromAdmin: true, isInternal: true, createdAt: true, author: { select: personSelect } },
        },
      },
    });
    if (!ticket) {
      throw new NotFoundError('Không tìm thấy yêu cầu hỗ trợ');
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

  async replyAsAdmin(ticketId: number, adminId: number, input: AdminReplyInput) {
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
        data: { ticketId, authorId: adminId, fromAdmin: true, isInternal: input.isInternal, body: input.body },
      });

      if (!input.isInternal) {
        // A public answer hands the ticket back to the store unless it is already resolved.
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            lastMessageAt: now,
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
