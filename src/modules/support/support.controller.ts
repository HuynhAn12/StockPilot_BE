import { NextFunction, Request, Response } from 'express';
import { IncomingFile, RequestMeta, SupportService } from './support.service';

const service = new SupportService();

function requestMeta(req: Request): RequestMeta {
  return { ipAddress: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null };
}

const filesOf = (req: Request) => ((req.files as IncomingFile[] | undefined) ?? []);

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

/** Streams a stored image privately; never cached by shared caches, never sniffed as HTML. */
function sendAttachment(load: (req: Request) => Promise<{ data: Uint8Array; mimeType: string; fileName: string }>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = await load(req);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(Buffer.from(file.data));
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
  countStoreUnread: handle(async (req) => ({ body: { data: await service.countStoreUnread(req.user!.storeId!) } })),
  createTicket: handle(async (req) => ({
    status: 201,
    body: { data: await service.createTicket(req.user!.storeId!, req.user!.userId, req.body, filesOf(req)) },
  })),
  getStoreTicket: handle(async (req) => ({
    body: { data: await service.getStoreTicket(req.user!.storeId!, Number(req.params.id)) },
  })),
  replyAsStore: handle(async (req) => ({
    status: 201,
    body: { data: await service.replyAsStore(req.user!.storeId!, req.user!.userId, Number(req.params.id), req.body.body, filesOf(req)) },
  })),
  getStoreAttachment: sendAttachment((req) => service.getStoreAttachment(req.user!.storeId!, Number(req.params.attachmentId))),

  // Admin side
  listAdminTickets: handle(async (req) => {
    const result = await service.listAdminTickets(req.query as any);
    return { body: { data: result.items, pagination: result.pagination, summary: result.summary } };
  }),
  getAdminTicket: handle(async (req) => ({ body: { data: await service.getAdminTicket(Number(req.params.id)) } })),
  replyAsAdmin: handle(async (req) => ({
    status: 201,
    body: { data: await service.replyAsAdmin(Number(req.params.id), req.user!.userId, req.body, filesOf(req)) },
  })),
  updateTicket: handle(async (req) => ({
    body: { data: await service.updateTicket(Number(req.params.id), req.body, req.user!.userId, requestMeta(req)) },
  })),
  getAdminAttachment: sendAttachment((req) => service.getAdminAttachment(Number(req.params.attachmentId))),
};
