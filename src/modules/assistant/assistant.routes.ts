import { Router } from 'express';
import multer from 'multer';
import { AssistantController } from './assistant.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { assistantChatBodySchema, explainSkuQuerySchema } from './assistant.schema';

export const assistantRouter = Router();
const controller = new AssistantController();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

assistantRouter.use(authMiddleware);
assistantRouter.use(requireStoreScope);

// Explain single SKU
assistantRouter.get(
  '/sku/:stockItemId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: explainSkuQuerySchema }),
  controller.explainSku
);

// Explain store overview
assistantRouter.get(
  '/overview',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.explainStoreOverview
);

// Prioritized next actions (executed through the existing pricing/alert endpoints, never here)
assistantRouter.get(
  '/suggestions',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.suggestions
);

// Chat with assistant
assistantRouter.post(
  '/chat',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: assistantChatBodySchema }),
  controller.chat
);

// Chat history
assistantRouter.get(
  '/history',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.getHistory
);

// Transcribe speech using Groq Whisper API
assistantRouter.post(
  '/transcribe',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  upload.single('audio'),
  controller.transcribe
);
