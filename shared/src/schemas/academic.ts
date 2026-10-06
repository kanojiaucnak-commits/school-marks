import { z } from 'zod';
import { idSchema, isoDateSchema, paginationSchema } from './common.js';

/* Academic years ----------------------------------------------------------- */

export const createAcademicYearSchema = z
  .object({
    name: z.string().trim().min(3, 'Enter a name such as "2026-2027"').max(40),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    isCurrent: z.boolean().default(false),
    status: z.enum(['active', 'archived']).default('active'),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: 'End date must be after the start date',
    path: ['endDate'],
  });
export type CreateAcademicYearInput = z.infer<typeof createAcademicYearSchema>;

export const updateAcademicYearSchema = z
  .object({
    name: z.string().trim().min(3).max(40).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    isCurrent: z.boolean().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((data) => !(data.startDate && data.endDate) || data.endDate > data.startDate, {
    message: 'End date must be after the start date',
    path: ['endDate'],
  });
export type UpdateAcademicYearInput = z.infer<typeof updateAcademicYearSchema>;

/* Classes ------------------------------------------------------------------ */

export const createClassSchema = z.object({
  academicYearId: idSchema,
  name: z.string().trim().min(1, 'Enter the class name').max(20),
  level: z.coerce.number().int().min(0).max(20).nullable().optional(),
});
export type CreateClassInput = z.infer<typeof createClassSchema>;

export const updateClassSchema = z.object({
  name: z.string().trim().min(1).max(20).optional(),
  level: z.coerce.number().int().min(0).max(20).nullable().optional(),
});

/* Sections ----------------------------------------------------------------- */

export const createSectionSchema = z.object({
  classId: idSchema,
  name: z.string().trim().min(1, 'Enter the section name').max(10),
  classTeacherId: idSchema.nullable().optional(),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const updateSectionSchema = z.object({
  name: z.string().trim().min(1).max(10),
  classTeacherId: idSchema.nullable().optional(),
});

/* Subjects ----------------------------------------------------------------- */

export const createSubjectSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Enter a subject code')
    .max(20)
    .regex(/^[A-z0-9-]+$/i, 'Letters, numbers and hyphens only')
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2, 'Enter the subject name').max(80),
  description: z.string().trim().max(500).nullable().optional(),
  isElective: z.boolean().default(false),
});
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;

export const updateSubjectSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isElective: z.boolean().optional(),
});

/* Exams -------------------------------------------------------------------- */

export const createExamSchema = z.object({
  academicYearId: idSchema,
  name: z.string().trim().min(2, 'Enter the exam name').max(80),
  maxMarks: z.coerce.number().positive('Maximum marks must be greater than zero').max(10_000),
  weightage: z.coerce.number().positive().max(10).default(1),
  examDate: isoDateSchema.nullable().optional(),
  status: z.enum(['scheduled', 'ongoing', 'completed', 'cancelled']).default('scheduled'),
});
export type CreateExamInput = z.infer<typeof createExamSchema>;

export const updateExamSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    /** Changing maxMarks after marks exist would invalidate them — the API rejects it. */
    maxMarks: z.coerce.number().positive().max(10_000).optional(),
    weightage: z.coerce.number().positive().max(10).optional(),
    examDate: isoDateSchema.nullable().optional(),
    status: z.enum(['scheduled', 'ongoing', 'completed', 'cancelled']).optional(),
  })
  .refine((data) => !(data.maxMarks && data.weightage) || data.weightage > 0, {
    message: 'Weightage must be greater than zero',
    path: ['weightage'],
  });

/* Teacher assignments ------------------------------------------------------ */

export const createAssignmentSchema = z.object({
  teacherId: idSchema,
  academicYearId: idSchema,
  classId: idSchema,
  sectionId: idSchema,
  subjectId: idSchema,
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const listAssignmentsSchema = z
  .object({
    teacherId: idSchema.optional(),
    academicYearId: idSchema.optional(),
    classId: idSchema.optional(),
    sectionId: idSchema.optional(),
    subjectId: idSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .optional()
  .default({});
export type ListAssignmentsInput = z.infer<typeof listAssignmentsSchema>;

/* Reference data lookups --------------------------------------------------- */

export const listSubjectsSchema = z
  .object({
    search: z.string().trim().max(80).optional(),
    includeInactive: z.coerce.boolean().default(false),
  })
  .optional()
  .default({});

export const listExamsSchema = z
  .object({
    academicYearId: idSchema.optional(),
  })
  .optional()
  .default({});

export const listClassesSchema = z
  .object({
    academicYearId: idSchema.optional(),
  })
  .optional()
  .default({});

export const listSectionsSchema = z
  .object({
    classId: idSchema.optional(),
  })
  .optional()
  .default({});

export const listAcademicYearsSchema = z
  .object({
    includeArchived: z.coerce.boolean().default(true),
  })
  .optional()
  .default({});

/* Grading schemes ---------------------------------------------------------- */

export const gradingRuleSchema = z.object({
  grade: z.string().trim().min(1, 'Enter the grade label').max(8),
  minPercentage: z.coerce.number().min(0).max(100),
  maxPercentage: z.coerce.number().min(0).max(100),
  gradePoint: z.coerce.number().min(0).max(10).nullable().optional(),
  isPass: z.boolean().default(true),
});

export const createGradingSchemeSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a scheme name').max(60),
    description: z.string().trim().max(500).nullable().optional(),
    isDefault: z.boolean().default(false),
    rules: z
      .array(gradingRuleSchema)
      .min(1, 'Add at least one grade rule')
      .max(50)
      .refine(
        (rules) => {
          const sorted = [...rules].sort((a, b) => a.minPercentage - b.minPercentage);
          for (let i = 1; i < sorted.length; i += 1) {
            const previous = sorted[i - 1];
            const current = sorted[i];
            if (!previous || !current) continue;
            if (current.minPercentage <= previous.maxPercentage) return false;
          }
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          return first?.minPercentage === 0 && last?.maxPercentage === 100;
        },
        {
          message:
            'Grade bands must not overlap and must together cover 0 to 100 (lowest band starts at 0, highest ends at 100)',
        },
      ),
  });
export type CreateGradingSchemeInput = z.infer<typeof createGradingSchemeSchema>;

export const updateGradingSchemeSchema = createGradingSchemeSchema.partial().extend({
  id: idSchema.optional(),
});

/* Settings ----------------------------------------------------------------- */

export const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export { paginationSchema };