import { z } from 'zod';
import {
  idSchema,
  markStatusSchema,
  submissionStatusSchema,
} from './common.js';

/* The five keys that identify one "mark sheet" in the UI. */
export const marksContextSchema = z.object({
  academicYearId: idSchema,
  classId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
  examId: idSchema,
});
export type MarksContext = z.infer<typeof marksContextSchema>;

/* Saving the grid ---------------------------------------------------------- */

export const saveMarksRowSchema = z.object({
  studentId: idSchema,
  marks: z.union([z.string(), z.number(), z.null()]),
  status: markStatusSchema.default('PRESENT'),
  remarks: z.string().trim().max(300).nullable().optional(),
});
export type SaveMarksRowInput = z.infer<typeof saveMarksRowSchema>;

export const saveMarksSchema = z.object({
  context: marksContextSchema,
  /**
   * `draft: true` persists rows even when some are invalid (partial autosave).
   * `draft: false` requires every row to validate — used on explicit Save.
   */
  draft: z.boolean().default(true),
  /** Optimistic concurrency guard against a stale grid overwriting newer data. */
  expectedVersion: z.number().int().min(0).optional(),
  rows: z.array(saveMarksRowSchema).min(1, 'No rows to save').max(500),
});
export type SaveMarksInput = z.infer<typeof saveMarksSchema>;

export const saveMarkSchema = z.object({
  marks: z.union([z.string(), z.number(), z.null()]),
  status: markStatusSchema.default('PRESENT'),
  remarks: z.string().trim().max(300).nullable().optional(),
  /** Required (and validated) whenever the mark sheet is locked or approved. */
  reason: z.string().trim().min(3, 'A reason is required').max(500).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

/* Reading ------------------------------------------------------------------ */

export const marksGridQuerySchema = z.object({
  academicYearId: idSchema,
  classId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
  examId: idSchema,
  search: z.string().trim().max(120).optional(),
  status: submissionStatusSchema.optional(),
  subjectIds: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .optional(),
});
export type MarksGridQuery = z.infer<typeof marksGridQuerySchema>;

export const listMarksSchema = z
  .object({
    studentId: idSchema.optional(),
    subjectId: idSchema.optional(),
    examId: idSchema.optional(),
    academicYearId: idSchema.optional(),
    classId: idSchema.optional(),
    sectionId: idSchema.optional(),
    status: submissionStatusSchema.optional(),
    markStatus: markStatusSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .optional()
  .default({});
export type ListMarksInput = z.infer<typeof listMarksSchema>;

/* Workflow actions --------------------------------------------------------- */

export const submitMarksSchema = z.object({
  context: marksContextSchema,
  /** Optional teacher note for the reviewer. */
  comments: z.string().trim().max(1000).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
});
export type SubmitMarksInput = z.infer<typeof submitMarksSchema>;

/**
 * The submission is identified by the URL (`/api/submissions/:id/...`). These
 * schemas deliberately carry no `submissionId`: a body copy that the server
 * ignores is an invitation to send one id in the path and another in the body,
 * and nobody reading the request later can tell which one won.
 */
export const reviewActionSchema = z.object({
  comments: z.string().trim().max(1000).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
});
export type ReviewActionInput = z.infer<typeof reviewActionSchema>;

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'RETURNED', 'REJECTED']),
    /**
     * Returning or rejecting a sheet without explanation leaves the teacher
     * guessing, so a comment is mandatory for those two decisions.
     */
    comments: z.string().trim().max(1000).nullable().optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine(
    (data) =>
      data.decision === 'APPROVED' ||
      (typeof data.comments === 'string' && data.comments.trim().length >= 3),
    {
      message: 'Provide review comments explaining the correction required',
      path: ['comments'],
    },
  );
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;

export const lockMarksSchema = z.object({
  comments: z.string().trim().max(1000).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
});
export type LockMarksInput = z.infer<typeof lockMarksSchema>;

export const listSubmissionsSchema = z
  .object({
    academicYearId: idSchema.optional(),
    classId: idSchema.optional(),
    sectionId: idSchema.optional(),
    subjectId: idSchema.optional(),
    examId: idSchema.optional(),
    teacherId: idSchema.optional(),
    status: z
      .union([submissionStatusSchema, z.array(submissionStatusSchema)])
      .optional(),
    search: z.string().trim().max(120).optional(),
    /** Convenience filter for "my sheets" in the teacher UI. */
    mine: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .optional()
  .default({});
export type ListSubmissionsInput = z.infer<typeof listSubmissionsSchema>;

/* Correcting a locked mark (elevated, always audited) ---------------------- */

export const correctLockedMarkSchema = z.object({
  marks: z.union([z.string(), z.number(), z.null()]),
  status: markStatusSchema.default('PRESENT'),
  /** Mandatory — Business Rule: locked corrections must be justified. */
  reason: z.string().trim().min(10, 'A detailed reason is required (at least 10 characters)').max(500),
  remarks: z.string().trim().max(300).nullable().optional(),
});
export type CorrectLockedMarkInput = z.infer<typeof correctLockedMarkSchema>;

/* Audit log listing -------------------------------------------------------- */

export const listAuditLogsSchema = z
  .object({
    userId: idSchema.optional(),
    action: z.string().trim().max(60).optional(),
    entityType: z.string().trim().max(40).optional(),
    entityId: z.string().trim().max(64).optional(),
    from: z.string().trim().max(30).optional(),
    to: z.string().trim().max(30).optional(),
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .optional()
  .default({});
export type ListAuditLogsInput = z.infer<typeof listAuditLogsSchema>;