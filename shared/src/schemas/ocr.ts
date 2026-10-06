import { z } from 'zod';
import { idSchema, markStatusSchema, paginationSchema } from './common.js';

/* Upload ------------------------------------------------------------------- */

export const ocrUploadMetaSchema = z.object({
  academicYearId: idSchema,
  classId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
  examId: idSchema,
});
export type OcrUploadMeta = z.infer<typeof ocrUploadMetaSchema>;

/* Reading ------------------------------------------------------------------ */

export const listOcrDocumentsSchema = z
  .object({
    academicYearId: idSchema.optional(),
    classId: idSchema.optional(),
    sectionId: idSchema.optional(),
    subjectId: idSchema.optional(),
    examId: idSchema.optional(),
    status: z.string().trim().max(20).optional(),
    mine: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .optional()
  .default({});
export type ListOcrDocumentsInput = z.infer<typeof listOcrDocumentsSchema>;

/* Editing extracted rows --------------------------------------------------- */

export const ocrRowPatchSchema = z.object({
  rowId: idSchema,
  /** Explicit student assignment. Ambiguous rows must be resolved by a human. */
  matchedStudentId: idSchema.nullable().optional(),
  /** Corrected numeric mark as typed by the teacher ("" clears it). */
  correctedMarks: z.string().trim().max(20).nullable().optional(),
  correctedStatus: markStatusSchema.nullable().optional(),
  remarks: z.string().trim().max(300).nullable().optional(),
  verified: z.boolean().optional(),
});
export type OcrRowPatchInput = z.infer<typeof ocrRowPatchSchema>;

export const updateOcrResultsSchema = z.object({
  rows: z.array(ocrRowPatchSchema).min(1).max(500),
});
export type UpdateOcrResultsInput = z.infer<typeof updateOcrResultsSchema>;

/**
 * Confirming is the *only* path by which OCR output becomes real marks, and it
 * always writes them as a DRAFT sheet that a teacher still has to submit.
 */
export const confirmOcrSchema = z.object({
  /** When true the confirmed marks are marked verified and the doc is archived as CONFIRMED. */
  markReviewed: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

export const retryOcrSchema = z.object({
  /** Override the configured provider for a single retry. */
  provider: z.string().trim().max(40).optional(),
});

export const ocrDocumentIdSchema = z.object({ id: idSchema });

export { paginationSchema };