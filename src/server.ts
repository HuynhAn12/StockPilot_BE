import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/db';

async function startServer() {
  try {
    await prisma.$connect();
    console.log('✅ Connected to MySQL Database successfully');
  } catch (error) {
    console.error('❌ Failed to connect to MySQL database on startup:', error);
    if (env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 StockPilot Backend API running on http://localhost:${env.PORT}/api/v1 (ENV: ${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} signal received: closing HTTP server...`);
    server.close(async () => {
      await prisma.$disconnect();
      console.log('✅ Database connection closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
