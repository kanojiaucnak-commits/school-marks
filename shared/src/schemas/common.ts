import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_UPLOAD_BYTES,
  ALL_MARK_STATUSES,
  ALL_ROLES,
  ALL_SUBMISSION_STATUSES,
  GENDER,
  STUDENT_STATUS,
  USER_STATUS,
  ALLOWED_UPLOAD_TYPES,
  EXPORT_FORMAT,
  MIN_PASSWORD_LENGTH,
} from '../constants.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');

/** ISO date (YYYY-MM-DD). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Invalid date');

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, underscore and hyphen only');

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200, 'At most 200 characters')
  .refine((value) => /[a-z]/.test(value), 'Include a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Include an uppercase letter')
  .refine((value) => /[0-9]/.test(value), 'Include a number');

/**
 * Password rules are enforced when a *new* password is set. Login only checks
 * presence — existing hashes are never re-validated against policy on login.
 */
export const newPasswordSchema = passwordSchema;

export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[0-9+()\-.\s]*$/, 'Invalid phone number')
  .optional()
  .nullable()
  .transform((value) => (value ? value : null));

export const marksValueSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (text === '') return null;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  })
  .refine((value) => value === null || Number.isNaN(value) || value >= 0, {
    message: 'Marks cannot be negative',
  });

export const markStatusSchema = z.enum(
  ALL_MARK_STATUSES as unknown as [string, ...string[]],
) as unknown as z.ZodType<(typeof ALL_MARK_STATUSES)[number]>;

export const roleSchema = z.enum(ALL_ROLES as unknown as [string, ...string[]]);
export const submissionStatusSchema = z.enum(
  ALL_SUBMISSION_STATUSES as unknown as [string, ...string[]],
);
export const userStatusSchema = z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE]);
export const studentStatusSchema = z.enum([
  STUDENT_STATUS.ACTIVE,
  STUDENT_STATUS.INACTIVE,
  STUDENT_STATUS.GRADUATED,
  STUDENT_STATUS.TRANSFERRED,
]);
export const genderSchema = z.enum([GENDER.MALE, GENDER.FEMALE, GENDER.OTHER]);

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    items: z.array(item),
  });
}

/** Offset/limit helper derived from page params. */
export function toOffsetLimit(page: number, pageSize: number): { offset: number; limit: number } {
  return { offset: (page - 1) * pageSize, limit: pageSize };
}

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

export const allowedUploadTypeSchema = z.enum(
  ALLOWED_UPLOAD_TYPES as unknown as [string, ...string[]],
);

export const uploadConstraints = {
  maxBytes: MAX_UPLOAD_BYTES,
  allowedTypes: ALLOWED_UPLOAD_TYPES,
};

/**
 * Literal tuple (not `Object.values`) so the inferred type stays the narrow
 * `ExportFormat` union rather than widening to `string`.
 */
export const exportFormatSchema = z.enum(['csv', 'xlsx', 'pdf', 'json']);