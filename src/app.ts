import express, { Express } from 'express';
import cors from 'cors';
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

export function createApp(): Express {
  const app = express();

  // Global Middlewares
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestIdMiddleware);
  app.use(sensitiveFieldsMiddleware);

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
    } catch (error: any) {
      return res.status(503).json({ status: 'UNREADY', database: 'DISCONNECTED', error: error.message });
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

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}
