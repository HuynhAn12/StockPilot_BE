import { PrismaClient } from '@prisma/client';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const rawPrisma =
  global.prisma ||
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

const originalTx = rawPrisma.$transaction.bind(rawPrisma);
rawPrisma.$transaction = function (arg: any, options?: any) {
  if (typeof arg === 'function') {
    const defaultOptions = { maxWait: 10_000, timeout: 30_000 };
    return originalTx(arg, { ...defaultOptions, ...options });
  }
  return originalTx(arg, options);
} as any;

export const prisma = rawPrisma;

if (env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
