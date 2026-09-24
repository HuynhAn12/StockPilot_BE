import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(5000),
    DATABASE_URL: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_REFRESH_SECRET: z.string().optional(),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    CORS_ORIGIN: z.string().default('*'),
    APP_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh').refine(isValidTimeZone, {
      message: 'APP_TIMEZONE must be a valid IANA timezone name',
    }),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        return (
          Boolean(data.DATABASE_URL) &&
          Boolean(data.JWT_SECRET) &&
          Boolean(data.JWT_REFRESH_SECRET) &&
          data.CORS_ORIGIN !== '*'
        );
      }
      return true;
    },
    {
      message: 'FATAL: Production mode requires DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, and explicit CORS_ORIGIN.',
      path: ['NODE_ENV'],
    }
  );

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables configuration:');
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));
  process.exit(1);
}

export const env = {
  ...parsedEnv.data,
  DATABASE_URL: parsedEnv.data.DATABASE_URL || 'mysql://root:password@127.0.0.1:3306/stockpilot_dev',
  JWT_SECRET: parsedEnv.data.JWT_SECRET || 'stockpilot-secret-jwt-key-2026',
  JWT_REFRESH_SECRET: parsedEnv.data.JWT_REFRESH_SECRET || 'stockpilot-secret-refresh-key-2026',
};
