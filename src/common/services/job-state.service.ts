import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { env } from '../../config/env';
import { logger } from '../logger';

/**
 * Background-job state persisted in `system_settings` (same approach as DbLeaseService and the
 * Decision Engine "last-run" row — no schema migration). Rows use internal "job:" / "lease:" keys
 * that the SystemSetting admin API never lists.
 */
export const JOB_STATE_KEYS = {
  lastRun: (jobName: string) => `job:${jobName}:last-run`,
  lastFailure: (jobName: string) => `job:${jobName}:last-failure`,
  lease: (leaseName: string) => `lease:${leaseName}`,
};

const MAX_ERROR_MESSAGE = 500;

/**
 * Records the latest failure of a background job so admins can see it without reading server logs.
 * Never throws: a failure to record must not mask the original job error.
 */
export async function recordJobFailure(
  jobName: string,
  error: unknown,
  db?: Pick<PrismaClient, 'systemSetting'>
): Promise<void> {
  // Unit tests must never write to a real database implicitly; tests pass an explicit client.
  const client = db ?? (env.NODE_ENV === 'test' ? null : defaultPrisma);
  if (!client) return;
  const message = (error instanceof Error ? error.message : String(error ?? 'Unknown error')).slice(0, MAX_ERROR_MESSAGE);
  const key = JOB_STATE_KEYS.lastFailure(jobName);
  const valueJson = { at: new Date().toISOString(), message };
  try {
    await client.systemSetting.upsert({
      where: { key },
      create: { key, valueJson, description: 'Internal job failure state (not a user setting)' },
      update: { valueJson },
    });
  } catch (recordError: any) {
    logger.warn('job_failure_record_failed', { jobName, message: recordError?.message });
  }
}
