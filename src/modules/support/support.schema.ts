import { z } from 'zod';
import { paginationQuerySchema } from '../../common/utils/pagination';

export const SUPPORT_CATEGORIES = ['DATA_IMPORT', 'PAYMENT', 'ACCOUNT', 'BUG', 'HOW_TO', 'OTHER'] as const;
export const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_STORE', 'RESOLVED'] as const;
export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;

const emptyToUndefined = (val: unknown) => (val === '' || val === 'ALL' ? undefined : val);

const messageBody = z
  .string()
  .trim()
  .min(2, 'Nội dung quá ngắn')
  .max(5000, 'Nội dung tối đa 5.000 ký tự');

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(5, 'Tiêu đề cần ít nhất 5 ký tự').max(200),
    category: z.enum(SUPPORT_CATEGORIES, { errorMap: () => ({ message: 'Vui lòng chọn loại yêu cầu' }) }),
    message: messageBody,
  })
  .strict();

/** Replies may be image-only; the service rejects a reply with neither text nor images. */
const optionalBody = z.string().trim().max(5000, 'Nội dung tối đa 5.000 ký tự').default('');

/** Multipart forms send every field as a string. */
const formBoolean = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export const replySchema = z.object({ body: optionalBody }).strict();

export const adminReplySchema = z
  .object({
    body: optionalBody,
    isInternal: formBoolean.default(false),
  })
  .strict();

export const adminUpdateTicketSchema = z
  .object({
    status: z.enum(SUPPORT_STATUSES).optional(),
    priority: z.enum(SUPPORT_PRIORITIES).optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'Không có thay đổi nào' });

export const storeTicketListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.preprocess(emptyToUndefined, z.enum(SUPPORT_STATUSES).optional()),
});

export const adminTicketListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.preprocess(emptyToUndefined, z.enum([...SUPPORT_STATUSES, 'ACTIVE'] as const).optional()),
  category: z.preprocess(emptyToUndefined, z.enum(SUPPORT_CATEGORIES).optional()),
  priority: z.preprocess(emptyToUndefined, z.enum(SUPPORT_PRIORITIES).optional()),
  storeId: z.coerce.number().int().positive().optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  unassigned: z.preprocess((v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v), z.boolean().optional()),
  search: z.preprocess(emptyToUndefined, z.string().trim().max(191).optional()),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export const attachmentParamSchema = z.object({ attachmentId: z.coerce.number().int().positive() });

export type AdminReplyInput = z.infer<typeof adminReplySchema>;
export type AdminUpdateTicketInput = z.infer<typeof adminUpdateTicketSchema>;
export type StoreTicketListQuery = z.infer<typeof storeTicketListQuerySchema>;
export type AdminTicketListQuery = z.infer<typeof adminTicketListQuerySchema>;
