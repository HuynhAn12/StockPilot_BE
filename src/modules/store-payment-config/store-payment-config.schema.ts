import { z } from 'zod';

export const upsertPayosConfigSchema = z
  .object({
    clientId: z.string().trim().max(500).optional(),
    apiKey: z.string().trim().max(1000).optional(),
    checksumKey: z.string().trim().max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const testPayosConfigSchema = z
  .object({
    clientId: z.string().trim().max(500).optional(),
    apiKey: z.string().trim().max(1000).optional(),
    checksumKey: z.string().trim().max(1000).optional(),
  })
  .strict();
