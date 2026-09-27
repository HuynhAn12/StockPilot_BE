import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/db';
import { logger } from './common/logger';

async function startServer() {
  let isShuttingDown = false;
  const serverRef: { current?: ReturnType<ReturnType<typeof createApp>['listen']> } = {};

  const shutdown = async (signal: string, exitCode = 0) => {
    if (isShuttingDown) {
      logger.warn('shutdown_already_in_progress', { signal });
      return;
    }

    isShuttingDown = true;
    logger.info('shutdown_started', { signal });

    const forceExit = setTimeout(() => {
      logger.error('shutdown_timeout_exceeded', {
        signal,
        timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      });
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      if (serverRef.current) {
        await new Promise<void>((resolve, reject) => {
          serverRef.current!.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }

      await prisma.$disconnect();
      logger.info('shutdown_completed', { signal });
      clearTimeout(forceExit);
      process.exit(exitCode);
    } catch (error) {
      logger.error('shutdown_failed', { signal, error });
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  try {
    await prisma.$connect();
    logger.info('database_connected');
  } catch (error) {
    logger.error('database_startup_connection_failed', { error });
    process.exit(1);
  }

  const app = createApp();

  serverRef.current = app.listen(env.PORT, () => {
    logger.info('http_server_started', {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      keepAliveTimeoutMs: env.KEEP_ALIVE_TIMEOUT_MS,
      headersTimeoutMs: env.HEADERS_TIMEOUT_MS,
    });
  });

  serverRef.current.requestTimeout = env.REQUEST_TIMEOUT_MS;
  serverRef.current.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;
  serverRef.current.headersTimeout = env.HEADERS_TIMEOUT_MS;

  serverRef.current.on('error', (error) => {
    logger.error('http_server_error', { error });
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { reason });
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error });
    shutdown('uncaughtException', 1);
  });
}

startServer().catch((error) => {
  logger.error('server_startup_failed', { error });
  process.exit(1);
});
