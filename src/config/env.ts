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

function parseTrustProxy(value: unknown): boolean | number {
  if (value === undefined || value === '') {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  const numericValue = Number(normalized);
  if (Number.isInteger(numericValue) && numericValue >= 0) {
    return numericValue;
  }

  return value as never;
}

function isStrongProductionSecret(value?: string): boolean {
  if (!value || value.length < 32) {
    return false;
  }

  return !/(change-me|changeme|default|stockpilot-secret|secret-key|password|example)/i.test(value);
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    DATABASE_URL: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_REFRESH_SECRET: z.string().optional(),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    CORS_ORIGIN: z.string().default('*'),
    APP_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh').refine(isValidTimeZone, {
      message: 'APP_TIMEZONE must be a valid IANA timezone name',
    }),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    TRUST_PROXY: z.preprocess(parseTrustProxy, z.union([z.boolean(), z.number().int().min(0)])).default(false),
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().optional(),
    GENERAL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    GENERAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(65_000),
    HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(66_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
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
  )
  .refine((data) => data.NODE_ENV !== 'production' || isStrongProductionSecret(data.JWT_SECRET), {
    message: 'FATAL: Production JWT_SECRET must be at least 32 characters and cannot be a placeholder/default.',
    path: ['JWT_SECRET'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || isStrongProductionSecret(data.JWT_REFRESH_SECRET), {
    message: 'FATAL: Production JWT_REFRESH_SECRET must be at least 32 characters and cannot be a placeholder/default.',
    path: ['JWT_REFRESH_SECRET'],
  })
  .refine(
    (data) => data.NODE_ENV !== 'production' || !data.CORS_ORIGIN.split(',').map((origin) => origin.trim()).includes('*'),
    {
      message: 'FATAL: Production CORS_ORIGIN cannot include wildcard origin.',
      path: ['CORS_ORIGIN'],
    }
  );

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  process.stderr.write('Invalid environment variables configuration.\n');
  process.stderr.write(`${JSON.stringify(parsedEnv.error.format(), null, 2)}\n`);
  process.exit(1);
}

export const env = {
  ...parsedEnv.data,
  DATABASE_URL: parsedEnv.data.DATABASE_URL || 'mysql://root:password@127.0.0.1:3306/stockpilot_dev',
  JWT_SECRET: parsedEnv.data.JWT_SECRET || 'stockpilot-secret-jwt-key-2026',
  JWT_REFRESH_SECRET: parsedEnv.data.JWT_REFRESH_SECRET || 'stockpilot-secret-refresh-key-2026',
};
