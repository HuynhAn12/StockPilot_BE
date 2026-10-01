import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { prisma } from './config/db';
import { requestIdMiddleware } from './common/middleware/request-id';
import { sensitiveFieldsMiddleware } from './common/middleware/sensitive-fields';
import { errorHandler } from './common/middleware/error-handler';
import { requestLoggerMiddleware } from './common/middleware/request-logger';
import { tenantResolverMiddleware } from './common/middleware/tenant';
import { logger } from './common/logger';

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
import { stockTakeRouter } from './modules/stock-takes/stock-take.routes';
import { notificationRouter } from './modules/notifications/notification.routes';
import { storePaymentConfigRouter } from './modules/store-payment-config/store-payment-config.routes';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);

  // Security Headers
  app.use(helmet());

  const corsOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

  // CORS Policy
  app.use(
    cors({
      origin: env.NODE_ENV === 'production' ? corsOrigins : true,
      credentials: true,
    })
  );

  // Body Parsing limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Request ID, request telemetry, and sensitive data masking
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(sensitiveFieldsMiddleware);

  // Rate Limiting (Skip in test environment)
  if (env.NODE_ENV !== 'test') {
    const generalLimiter = rateLimit({
      windowMs: env.GENERAL_RATE_LIMIT_WINDOW_MS,
      max: env.GENERAL_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests, please try again later.',
            requestId: (req as any).requestId,
          },
        }),
    });
    app.use('/api/', generalLimiter);

    const authLimiter = rateLimit({
      windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
      max: env.AUTH_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          success: false,
          error: {
            code: 'AUTH_RATE_LIMIT_EXCEEDED',
            message: 'Too many authentication attempts, please try again later.',
            requestId: (req as any).requestId,
          },
        }),
    });
    app.use('/api/v1/auth/login', authLimiter);
    app.use('/api/v1/auth/refresh', authLimiter);
    app.use('/api/v1/auth/forgot-password', authLimiter);
    app.use('/api/v1/auth/reset-password', authLimiter);
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
    } catch (error) {
      logger.warn('readiness_check_failed', {
        requestId: (req as any).requestId,
        error,
      });
      return res.status(503).json({ status: 'UNREADY', database: 'DISCONNECTED' });
    }
  });

  app.use(tenantResolverMiddleware);

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
  app.use('/api/v1/stock-takes', stockTakeRouter);
  app.use('/api/v1/notifications', notificationRouter);
  app.use('/api/v1/store/payment-config', storePaymentConfigRouter);

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}
