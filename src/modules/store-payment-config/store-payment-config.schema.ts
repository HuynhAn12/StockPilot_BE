import { z } from 'zod';

export const upsertPayosConfigSchema = z
  .object({
    clientId: z.string().trim().min(1).max(500),
    apiKey: z.string().trim().min(1).max(1000),
    checksumKey: z.string().trim().min(1).max(1000),
    isActive: z.boolean().optional(),
  })
  .strict();
