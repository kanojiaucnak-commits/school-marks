import { z } from 'zod';
import {
  genderSchema,
  idSchema,
  isoDateSchema,
  studentStatusSchema,
} from './common.js';

const studentCoreShape = {
  fullName: z.string().trim().min(2, 'Enter the student name').max(120),
  studentNumber: z
    .string()
    .trim()
    .min(1, 'Enter the student number')
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and hyphens only'),
  admissionNumber: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9-]*$/, 'Letters, numbers and hyphens only')
    .nullable()
    .optional(),
  rollNumber: z.coerce.number().int().min(0).max(9999).nullable().optional(),
  dateOfBirth: isoDateSchema.nullable().optional(),
  gender: genderSchema.nullable().optional(),
  classId: idSchema,
  sectionId: idSchema,
  academicYearId: idSchema,
  guardianName: z.string().trim().max(120).nullable().optional(),
  guardianPhone: z.string().trim().max(32).nullable().optional(),
  guardianEmail: z
    .string()
    .trim()
    .email()
    .max(254)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  address: z.string().trim().max(400).nullable().optional(),
  status: studentStatusSchema.optional(),
};

export const createStudentSchema = z
  .object(studentCoreShape)
  .refine((data) => !data.dateOfBirth || data.dateOfBirth <= new Date().toISOString().slice(0, 10), {
    message: 'Date of birth cannot be in the future',
    path: ['dateOfBirth'],
  });
export type CreateStudentInput = z.infer<typeof createStudentSchema>;

export const updateStudentSchema = z.object(studentCoreShape).partial();
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;

export const listStudentsSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    /** Convenience alias matched against student_number and admission_number. */
    studentNumber: z.string().trim().max(40).optional(),
    classId: idSchema.optional(),
    sectionId: idSchema.optional(),
    academicYearId: idSchema.optional(),
    status: studentStatusSchema.optional(),
    /** Free-text roll number filter, so "0" and "1" both work. */
    rollNumber: z.coerce.number().int().min(0).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(['name', 'rollNumber', 'studentNumber', 'createdAt']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .optional()
  .default({});
export type ListStudentsInput = z.infer<typeof listStudentsSchema>;

export const studentHistorySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .optional()
  .default({});

/* CSV/XLSX import ---------------------------------------------------------- */

/** Column aliases accepted in the import file, mapped to canonical field names. */
export const IMPORT_COLUMN_ALIASES: Record<string, string> = {
  studentid: 'studentNumber',
  'student id': 'studentNumber',
  studentnumber: 'studentNumber',
  'student number': 'studentNumber',
  admissionid: 'admissionNumber',
  admissionno: 'admissionNumber',
  admissionnumber: 'admissionNumber',
  'admission number': 'admissionNumber',
  rollno: 'rollNumber',
  'roll no': 'rollNumber',
  rollnumber: 'rollNumber',
  'roll number': 'rollNumber',
  name: 'fullName',
  fullname: 'fullName',
  'full name': 'fullName',
  studentname: 'fullName',
  'student name': 'fullName',
  dob: 'dateOfBirth',
  dateofbirth: 'dateOfBirth',
  'date of birth': 'dateOfBirth',
  gender: 'gender',
  class: 'className',
  classname: 'className',
  'class name': 'className',
  section: 'sectionName',
  sectionname: 'sectionName',
  'section name': 'sectionName',
  academicyear: 'academicYearName',
  'academic year': 'academicYearName',
  academicyearname: 'academicYearName',
  guardianname: 'guardianName',
  'guardian name': 'guardianName',
  guardianphone: 'guardianPhone',
  'guardian phone': 'guardianPhone',
  guardianemail: 'guardianEmail',
  'guardian email': 'guardianEmail',
};

export const IMPORT_TEMPLATE_COLUMNS = [
  'Student ID',
  'Admission Number',
  'Roll Number',
  'Name',
  'Class',
  'Section',
  'Academic Year',
  'Date of Birth',
  'Gender',
  'Guardian Name',
  'Guardian Phone',
  'Guardian Email',
] as const;

export const importUploadSchema = z.object({
  academicYearId: idSchema,
  /** Year used to resolve class/section names when the file omits an Academic Year column. */
  file: z.any(),
});
export type ImportUploadInput = z.infer<typeof importUploadSchema>;

export const importCommitSchema = z.object({
  batchId: idSchema,
  /** When false (default) rows with validation errors are skipped and reported. */
  skipInvalidRows: z.boolean().default(true),
});
export type ImportCommitInput = z.infer<typeof importCommitSchema>;