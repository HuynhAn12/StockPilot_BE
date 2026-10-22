import { NextFunction, Request, Response } from 'express';
import { LeadService } from './lead.service';

const service = new LeadService();

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null };
}

export const leadController = {
  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await service.list(req.query as any);
      res.status(200).json({ success: true, data: result.items, pagination: result.pagination, summary: result.summary });
    } catch (error) {
      next(error);
    }
  },
  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true, data: await service.get(Number(req.params.id)) });
    } catch (error) {
      next(error);
    }
  },
  update: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await service.update(Number(req.params.id), req.body, req.user!.userId, requestMeta(req));
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },
  addNote: async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(201).json({ success: true, data: await service.addNote(Number(req.params.id), req.body, req.user!.userId) });
    } catch (error) {
      next(error);
    }
  },
};
