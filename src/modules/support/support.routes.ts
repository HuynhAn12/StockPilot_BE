import { Role } from '@prisma/client';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { ValidationError } from '../../common/errors/app-error';
import { idParamSchema } from '../../common/utils/pagination';
import { supportController as controller } from './support.controller';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './support.service';
import {
  adminReplySchema,
  adminTicketListQuerySchema,
  adminUpdateTicketSchema,
  attachmentParamSchema,
  createTicketSchema,
  replySchema,
  storeTicketListQuerySchema,
} from './support.schema';

// Images stay in memory; the service checks their real type from the bytes before storing them.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS },
}).array('files', MAX_ATTACHMENTS);

/** Accepts JSON or multipart (text fields + up to 3 images) and turns upload errors into 400s. */
function withImages(req: Request, res: Response, next: NextFunction) {
  imageUpload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Mỗi ảnh tối đa 5 MB'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Tối đa ${MAX_ATTACHMENTS} ảnh mỗi tin nhắn`
          : 'Không tải được ảnh';
      return next(new ValidationError(message));
    }
    next(err);
  });
}

/** /api/v1/support: store owners and staff talk to the platform team about their own store. */
export const supportRouter = Router();
supportRouter.use(authMiddleware);
supportRouter.use(requireStoreScope);
supportRouter.use(requireRole(Role.SHOP_OWNER, Role.WAREHOUSE_STAFF));

supportRouter.get('/unread-count', controller.countStoreUnread);
supportRouter.get('/tickets', validate({ query: storeTicketListQuerySchema }), controller.listStoreTickets);
supportRouter.post('/tickets', withImages, validate({ body: createTicketSchema }), controller.createTicket);
supportRouter.get('/tickets/:id', validate({ params: idParamSchema }), controller.getStoreTicket);
supportRouter.post('/tickets/:id/messages', withImages, validate({ params: idParamSchema, body: replySchema }), controller.replyAsStore);
supportRouter.get('/attachments/:attachmentId', validate({ params: attachmentParamSchema }), controller.getStoreAttachment);

/** /api/v1/admin/support: the platform team's inbox across every store. */
export const adminSupportRouter = Router();
adminSupportRouter.use(authMiddleware);
adminSupportRouter.use(requireRole(Role.ADMIN));

adminSupportRouter.get('/tickets', validate({ query: adminTicketListQuerySchema }), controller.listAdminTickets);
adminSupportRouter.get('/tickets/:id', validate({ params: idParamSchema }), controller.getAdminTicket);
adminSupportRouter.post(
  '/tickets/:id/messages',
  withImages,
  validate({ params: idParamSchema, body: adminReplySchema }),
  controller.replyAsAdmin
);
adminSupportRouter.patch('/tickets/:id', validate({ params: idParamSchema, body: adminUpdateTicketSchema }), controller.updateTicket);
adminSupportRouter.get('/attachments/:attachmentId', validate({ params: attachmentParamSchema }), controller.getAdminAttachment);
