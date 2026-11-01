import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { TaxSupportController } from './tax-support.controller';
import { revenueBookQuerySchema } from './tax-support.schema';

export const taxSupportRouter = Router();
const controller = new TaxSupportController();

taxSupportRouter.use(authMiddleware);
taxSupportRouter.use(requireStoreScope);
// Doanh thu là dữ liệu tài chính: chỉ chủ shop.
taxSupportRouter.use(requireRole('SHOP_OWNER'));

taxSupportRouter.get('/revenue-threshold', controller.revenueThreshold);
taxSupportRouter.get('/revenue-book/preview', validate({ query: revenueBookQuerySchema }), controller.revenueBookPreview);
taxSupportRouter.get('/revenue-book', validate({ query: revenueBookQuerySchema }), controller.revenueBookExport);
