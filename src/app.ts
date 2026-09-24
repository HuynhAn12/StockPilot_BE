import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { prisma } from './config/db';
import { requestIdMiddleware } from './common/middleware/request-id';
import { sensitiveFieldsMiddleware } from './common/middleware/sensitive-fields';
import { errorHandler } from './common/middleware/error-handler';

// Routers
import { authRouter } from './modules/auth/auth.routes';
import { userRouter } from './modules/users/user.routes';
import { categoryRouter } from './modules/categories/category.routes';
import { productRouter } from './modules/products/product.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { orderRouter } from './modules/orders/order.routes';
import { returnRouter } from './modules/returns/return.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { importRouter } from './modules/import-export/import.routes';
import { exportRouter } from './modules/import-export/export.routes';
import { historicalSalesRouter } from './modules/historical-sales/historical-sales.routes';
import { decisionEngineRouter } from './modules/decision-engine/decision-engine.routes';
import { alertRouter } from './modules/alerts/alert.routes';
import { pricingRouter } from './modules/pricing/pricing.routes';
import { assistantRouter } from './modules/assistant/assistant.routes';

export function createApp(): Express {
  const app = express();

  // Security Headers
  app.use(helmet());

  // CORS Policy
  app.use(
    cors({
      origin: env.NODE_ENV === 'production' ? env.CORS_ORIGIN : true,
      credentials: true,
    })
  );

  // Body Parsing limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Request ID & Sensitive Data Masking
  app.use(requestIdMiddleware);
  app.use(sensitiveFieldsMiddleware);

  // Rate Limiting (Skip in test environment)
  if (env.NODE_ENV !== 'test') {
    const generalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Quá nhiều yêu cầu, vui lòng thử lại sau 15 phút' } },
    });
    app.use('/api/', generalLimiter);

    const authLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'AUTH_RATE_LIMIT_EXCEEDED', message: 'Quá nhiều lần thử đăng nhập/làm mới token, vui lòng thử lại sau 1 phút' } },
    });
    app.use('/api/v1/auth/login', authLimiter);
    app.use('/api/v1/auth/refresh', authLimiter);
  }

  // Health check endpoints
  app.get('/api/v1/health', (req, res) => {
    return res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'StockPilot Backend Core API',
      version: '1.0.0',
    });
  });

  app.get('/api/v1/health/live', (req, res) => {
    return res.status(200).json({ status: 'ALIVE' });
  });

  app.get('/api/v1/health/ready', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.status(200).json({ status: 'READY', database: 'CONNECTED' });
    } catch {
      return res.status(503).json({ status: 'UNREADY', database: 'DISCONNECTED' });
    }
  });

  // Module routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/categories', categoryRouter);
  app.use('/api/v1/products', productRouter);
  app.use('/api/v1/inventory', inventoryRouter);
  app.use('/api/v1/orders', orderRouter);
  app.use('/api/v1/returns', returnRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/import/historical-sales', historicalSalesRouter);
  app.use('/api/v1/import', importRouter);
  app.use('/api/v1/export', exportRouter);
  app.use('/api/v1/historical-sales', historicalSalesRouter);
  app.use('/api/v1/decision-engine', decisionEngineRouter);
  app.use('/api/v1/alerts', alertRouter);
  app.use('/api/v1/recommendations', pricingRouter);
  app.use('/api/v1/pricing', pricingRouter);
  app.use('/api/v1/assistant', assistantRouter);

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}
