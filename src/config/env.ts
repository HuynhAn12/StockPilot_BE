import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(5000),
    DATABASE_URL: z.string().default('mysql://root:password@127.0.0.1:3306/stockpilot_dev'),
    JWT_SECRET: z.string().default('stockpilot-secret-jwt-key-2026'),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_REFRESH_SECRET: z.string().default('stockpilot-secret-refresh-key-2026'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    CORS_ORIGIN: z.string().default('*'),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        return (
          data.JWT_SECRET !== 'stockpilot-secret-jwt-key-2026' &&
          data.JWT_REFRESH_SECRET !== 'stockpilot-secret-refresh-key-2026'
        );
      }
      return true;
    },
    {
      message: 'FATAL: Production mode requires custom JWT_SECRET and JWT_REFRESH_SECRET variables.',
      path: ['JWT_SECRET'],
    }
  );

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables configuration:');
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));
  process.exit(1);
}

export const env = parsedEnv.data;
