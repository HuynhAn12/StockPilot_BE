import { z } from 'zod';

export const notificationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const notificationListQuerySchema = z.object({
  isRead: z
    .preprocess((value) => {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return value;
    }, z.boolean().optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
