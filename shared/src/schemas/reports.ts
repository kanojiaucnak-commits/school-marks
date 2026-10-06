import { z } from 'zod';
import { exportFormatSchema, idSchema, paginationSchema } from './common.js';

/* Student report ----------------------------------------------------------- */

export const studentReportQuerySchema = z.object({
  academicYearId: idSchema.optional(),
  examId: idSchema.optional(),
  /** Include every subject the student has marks for, not just the current exam. */
  allExams: z.coerce.boolean().default(false),
});
export type StudentReportQuery = z.infer<typeof studentReportQuerySchema>;

/* Class report ------------------------------------------------------------- */

export const classReportQuerySchema = z.object({
  academicYearId: idSchema,
  sectionId: idSchema,
  examId: idSchema,
  subjectIds: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .optional(),
});
export type ClassReportQuery = z.infer<typeof classReportQuerySchema>;

/* Subject report ----------------------------------------------------------- */

export const subjectReportQuerySchema = z.object({
  academicYearId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
  examId: idSchema,
  includeRows: z.coerce.boolean().default(true),
});
export type SubjectReportQuery = z.infer<typeof subjectReportQuerySchema>;

/* Submission report -------------------------------------------------------- */

export const submissionReportQuerySchema = z
  .object({
    academicYearId: idSchema.optional(),
    examId: idSchema.optional(),
    subjectId: idSchema.optional(),
    status: z.string().trim().max(20).optional(),
    page: paginationSchema.shape.page.default(1),
    pageSize: paginationSchema.shape.pageSize.default(50),
  })
  .optional()
  .default({});

/* Exports ------------------------------------------------------------------ */

export const studentExportQuerySchema = z.object({
  academicYearId: idSchema.optional(),
  classId: idSchema.optional(),
  sectionId: idSchema.optional(),
  status: z.string().trim().max(20).optional(),
  format: exportFormatSchema.default('csv'),
});

export const marksExportQuerySchema = z.object({
  academicYearId: idSchema,
  classId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
  examId: idSchema,
  format: exportFormatSchema.default('csv'),
});

export const reportExportQuerySchema = z.object({
  format: exportFormatSchema.default('pdf'),
  scope: z.enum(['student', 'class', 'subject', 'submission']).default('student'),
  targetId: idSchema,
  academicYearId: idSchema.optional(),
  sectionId: idSchema.optional(),
  subjectId: idSchema.optional(),
  examId: idSchema.optional(),
});

/**
 * Large exports are queued rather than generated inline: a server must not try to
 * synchronously produce a PDF that could exceed CPU/wall-clock limits.
 */
export const exportJobRequestSchema = z.object({
  kind: z.enum(['students', 'class-report', 'subject-report', 'submission-report']),
  format: exportFormatSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ExportJobRequest = z.infer<typeof exportJobRequestSchema>;

/* Notifications ------------------------------------------------------------ */

export const listNotificationsSchema = z
  .object({
    unreadOnly: z.coerce.boolean().default(false),
    page: paginationSchema.shape.page.default(1),
    pageSize: paginationSchema.shape.pageSize.default(25),
  })
  .optional()
  .default({});

export const markNotificationReadSchema = z.object({
  ids: z.array(idSchema).min(1).max(100),
});

export const unreadCountResponse = z.object({
  unread: z.number().int().nonnegative(),
});

/* Dashboards --------------------------------------------------------------- */

export const teacherDashboardQuerySchema = z.object({
  academicYearId: idSchema.optional(),
});

export const adminDashboardQuerySchema = z.object({
  academicYearId: idSchema.optional(),
});