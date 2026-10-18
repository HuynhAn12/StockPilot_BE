import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { ScannerController } from './scanner.controller';
import { createScanSessionSchema, submitScanSchema } from './scanner.schema';

export const scannerRouter = Router();
const controller = new ScannerController();

// POST /api/v1/scanner/pair — pair mobile scanner with 6-char code from web POS
scannerRouter.post('/pair', (req, res, next) => controller.pairSession(req, res, next));

// All protected scanner routes require authentication and store scoping
scannerRouter.use(authMiddleware);
scannerRouter.use(requireStoreScope);

// POST /api/v1/scanner/sessions — create pairing session (mobile app or web initiates)
scannerRouter.post(
  '/sessions',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: createScanSessionSchema }),
  (req, res, next) => controller.createSession(req, res, next)
);

// GET /api/v1/scanner/sessions — list active sessions for this store
scannerRouter.get(
  '/sessions',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.listSessions(req, res, next)
);

// GET /api/v1/scanner/sessions/:code/events — SSE stream for web browser
scannerRouter.get(
  '/sessions/:code/events',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.subscribeToSession(req, res, next)
);

// GET /api/v1/scanner/sessions/:code — check if a specific session is still valid
scannerRouter.get(
  '/sessions/:code',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.getSession(req, res, next)
);

// POST /api/v1/scanner/sessions/:code/scan — submit barcode scan from mobile
scannerRouter.post(
  '/sessions/:code/scan',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: submitScanSchema }),
  (req, res, next) => controller.processScan(req, res, next)
);

// DELETE /api/v1/scanner/sessions/:code — close session
scannerRouter.delete(
  '/sessions/:code',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.closeSession(req, res, next)
);
