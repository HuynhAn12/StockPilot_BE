import express, { Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { requestIdMiddleware } from './common/middleware/request-id';
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
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestIdMiddleware);

  // Health check endpoint
  app.get('/api/v1/health', (req, res) => {
    return res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'StockPilot Backend Core API',
      version: '1.0.0',
    });
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
