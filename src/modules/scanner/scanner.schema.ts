import { z } from 'zod';

export const createScanSessionSchema = z.object({
  label: z.string().max(100).optional(), // optional label for the session
});

export const submitScanSchema = z.object({
  barcode: z.string().min(1).max(100),
});
