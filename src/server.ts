import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/db';

const app = createApp();

const server = app.listen(env.PORT, async () => {
  console.log(`🚀 StockPilot Backend API running on http://localhost:${env.PORT}/api/v1`);
  try {
    await prisma.$connect();
    console.log('✅ Connected to MySQL Database successfully');
  } catch (error) {
    console.error('❌ Failed to connect to MySQL database:', error);
  }
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('Database connection closed');
  });
});
