import { env } from '../config/env';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type LogMetadata = Record<string, unknown>;

const levelRank: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const sensitiveKeyPattern = /(authorization|password|token|secret|cookie|database_url|databaseurl|jwt|refresh)/i;

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(env.NODE_ENV === 'production' ? {} : { stack: value.stack }),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<LogMetadata>((acc, [key, item]) => {
      acc[key] = sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitize(item);
      return acc;
    }, {});
  }

  return value;
}

function formatDevelopment(level: LogLevel, message: string, metadata?: LogMetadata): string {
  const safeMetadata = metadata ? sanitize(metadata) : undefined;
  const suffix = safeMetadata ? ` ${JSON.stringify(safeMetadata)}` : '';
  return `[${level.toUpperCase()}] ${message}${suffix}\n`;
}

function formatProduction(level: LogLevel, message: string, metadata?: LogMetadata): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(metadata ? (sanitize(metadata) as LogMetadata) : {}),
  })}\n`;
}

function write(level: LogLevel, message: string, metadata?: LogMetadata): void {
  if (levelRank[level] > levelRank[env.LOG_LEVEL]) {
    return;
  }

  if (env.NODE_ENV === 'test' && level !== 'error') {
    return;
  }

  const output =
    env.NODE_ENV === 'production'
      ? formatProduction(level, message, metadata)
      : formatDevelopment(level, message, metadata);
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(output);
}

export const logger = {
  error: (message: string, metadata?: LogMetadata) => write('error', message, metadata),
  warn: (message: string, metadata?: LogMetadata) => write('warn', message, metadata),
  info: (message: string, metadata?: LogMetadata) => write('info', message, metadata),
  debug: (message: string, metadata?: LogMetadata) => write('debug', message, metadata),
};
