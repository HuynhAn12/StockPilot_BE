import { NextFunction, Request, Response } from 'express';
import { RequestMeta, SupportService } from './support.service';

const service = new SupportService();

function requestMeta(req: Request): RequestMeta {
  return { ipAddress: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null };
}

type Handler = (req: Request) => Promise<{ status?: number; body: Record<string, unknown> }>;

function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status = 200, body } = await fn(req);
      res.status(status).json({ success: true, ...body });
    } catch (error) {
      next(error);
    }
  };
}

export const supportController = {
  // Store side: storeId always comes from the authenticated user.
  listStoreTickets: handle(async (req) => {
    const result = await service.listStoreTickets(req.user!.storeId!, req.query as any);
    return { body: { data: result.items, pagination: result.pagination } };
  }),
  createTicket: handle(async (req) => ({
    status: 201,
    body: { data: await service.createTicket(req.user!.storeId!, req.user!.userId, req.body) },
  })),
  getStoreTicket: handle(async (req) => ({
    body: { data: await service.getStoreTicket(req.user!.storeId!, Number(req.params.id)) },
  })),
  replyAsStore: handle(async (req) => ({
    status: 201,
    body: { data: await service.replyAsStore(req.user!.storeId!, req.user!.userId, Number(req.params.id), req.body.body) },
  })),

  // Admin side
  listAdminTickets: handle(async (req) => {
    const result = await service.listAdminTickets(req.query as any);
    return { body: { data: result.items, pagination: result.pagination, summary: result.summary } };
  }),
  getAdminTicket: handle(async (req) => ({ body: { data: await service.getAdminTicket(Number(req.params.id)) } })),
  replyAsAdmin: handle(async (req) => ({
    status: 201,
    body: { data: await service.replyAsAdmin(Number(req.params.id), req.user!.userId, req.body) },
  })),
  updateTicket: handle(async (req) => ({
    body: { data: await service.updateTicket(Number(req.params.id), req.body, req.user!.userId, requestMeta(req)) },
  })),
};
