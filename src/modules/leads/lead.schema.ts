import { z } from 'zod';
import { paginationQuerySchema } from '../../common/utils/pagination';

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'REJECTED'] as const;
export const LEAD_NOTE_TYPES = ['NOTE', 'CALL', 'EMAIL', 'MEETING'] as const;

const emptyOrAllToUndefined = (val: unknown) => (val === '' || val === 'ALL' ? undefined : val);

export const leadListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.preprocess(emptyOrAllToUndefined, z.string().trim().max(191).optional()),
  status: z.preprocess(emptyOrAllToUndefined, z.enum(LEAD_STATUSES).optional()),
  assigneeId: z.coerce.number().int().positive().optional(),
  /** NEW leads waiting more than 24 hours without contact. */
  overdue: z.preprocess((v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v), z.boolean().optional()),
  unassigned: z.preprocess((v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v), z.boolean().optional()),
});

export const updateLeadSchema = z
  .object({
    status: z.enum(LEAD_STATUSES, { errorMap: () => ({ message: 'Trạng thái lead không hợp lệ' }) }).optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((data) => data.status !== undefined || data.assigneeId !== undefined, { message: 'Không có thay đổi nào' });

/** Legacy body for PATCH /admin/leads/:id/status. */
export const updateLeadStatusSchema = z
  .object({ status: z.enum(LEAD_STATUSES, { errorMap: () => ({ message: 'Trạng thái lead không hợp lệ' }) }) })
  .strict();

export const addLeadNoteSchema = z
  .object({
    type: z.enum(LEAD_NOTE_TYPES).default('NOTE'),
    body: z.string().trim().min(2, 'Nội dung quá ngắn').max(2000, 'Tối đa 2.000 ký tự'),
  })
  .strict();

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type AddLeadNoteInput = z.infer<typeof addLeadNoteSchema>;
