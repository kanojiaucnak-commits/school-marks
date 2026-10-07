/**
 * Canonical enumerations shared by the Postgres schema, the Edge Functions and the
 * React frontend. Keep these in sync with the CHECK constraints in
 * `supabase/migrations/0001_schema.sql`.
 */

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

export const ROLES = {
  ADMIN: 'admin',
  TEACHER: 'teacher',
  REVIEWER: 'reviewer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
export const ALL_ROLES: Role[] = [ROLES.ADMIN, ROLES.TEACHER, ROLES.REVIEWER];

/* -------------------------------------------------------------------------- */
/* Marks workflow                                                              */
/* -------------------------------------------------------------------------- */

/**
 * DRAFT ──submit──▶ SUBMITTED ──start review──▶ UNDER_REVIEW ──approve──▶ APPROVED ──lock──▶ LOCKED
 *   ▲                    │                          │
 *   └────return───────────┴──────────────────────────┘
 *   (RETURNED behaves like DRAFT: editable, then resubmittable)
 */
export const SUBMISSION_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  LOCKED: 'LOCKED',
  RETURNED: 'RETURNED',
  REJECTED: 'REJECTED',
} as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUS)[keyof typeof SUBMISSION_STATUS];
export const ALL_SUBMISSION_STATUSES: SubmissionStatus[] = Object.values(SUBMISSION_STATUS);

/** Statuses in which a teacher may still add or edit marks. */
export const EDITABLE_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SUBMISSION_STATUS.DRAFT,
  SUBMISSION_STATUS.RETURNED,
  SUBMISSION_STATUS.REJECTED,
];

/** Statuses from which marks are frozen. */
export const FROZEN_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SUBMISSION_STATUS.APPROVED,
  SUBMISSION_STATUS.LOCKED,
];

/**
 * Allowed workflow transitions. Enforced server-side; the frontend uses it to
 * decide which buttons to render so the UI can never offer an illegal action.
 */
export const SUBMISSION_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  DRAFT: [SUBMISSION_STATUS.SUBMITTED],
  RETURNED: [SUBMISSION_STATUS.SUBMITTED],
  REJECTED: [SUBMISSION_STATUS.SUBMITTED],
  SUBMITTED: [
    SUBMISSION_STATUS.UNDER_REVIEW,
    SUBMISSION_STATUS.APPROVED,
    SUBMISSION_STATUS.RETURNED,
    SUBMISSION_STATUS.REJECTED,
  ],
  UNDER_REVIEW: [
    SUBMISSION_STATUS.APPROVED,
    SUBMISSION_STATUS.RETURNED,
    SUBMISSION_STATUS.REJECTED,
  ],
  APPROVED: [SUBMISSION_STATUS.LOCKED, SUBMISSION_STATUS.RETURNED],
  LOCKED: [],
};

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return SUBMISSION_TRANSITIONS[from]?.includes(to) ?? false;
}

/* -------------------------------------------------------------------------- */
/* Marks value status                                                          */
/* -------------------------------------------------------------------------- */

export const MARK_STATUS = {
  PRESENT: 'PRESENT',
  ABSENT: 'ABSENT',
  EXEMPTED: 'EXEMPTED',
  MEDICAL: 'MEDICAL',
} as const;

export type MarkStatus = (typeof MARK_STATUS)[keyof typeof MARK_STATUS];
export const ALL_MARK_STATUSES: MarkStatus[] = Object.values(MARK_STATUS);

/** Statuses for which `marks_obtained` must be NULL — these are not numeric marks. */
export const NON_NUMERIC_MARK_STATUSES: MarkStatus[] = [
  MARK_STATUS.ABSENT,
  MARK_STATUS.EXEMPTED,
  MARK_STATUS.MEDICAL,
];

export function isNumericMarkStatus(status: MarkStatus): boolean {
  return !NON_NUMERIC_MARK_STATUSES.includes(status);
}

export const MARK_SOURCE = {
  MANUAL: 'manual',
  OCR: 'ocr',
  IMPORT: 'import',
} as const;

export type MarkSource = (typeof MARK_SOURCE)[keyof typeof MARK_SOURCE];

/* -------------------------------------------------------------------------- */
/* OCR                                                                         */
/* -------------------------------------------------------------------------- */

export const OCR_STATUS = {
  UPLOADED: 'UPLOADED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
} as const;

export type OcrStatus = (typeof OCR_STATUS)[keyof typeof OCR_STATUS];

/** OCR results at or above this confidence are treated as reliable suggestions. */
export const OCR_CONFIDENCE = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  /** Anything below MEDIUM must be manually verified before confirmation. */
  REVIEW_THRESHOLD: 0.7,
} as const;

export function confidenceBand(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= OCR_CONFIDENCE.HIGH) return 'high';
  if (confidence >= OCR_CONFIDENCE.MEDIUM) return 'medium';
  return 'low';
}

export const OCR_MATCH_METHOD = {
  /**
   * Legacy only. The matcher stopped identifying students by student or
   * admission number (roll number and name are the only identities now), but
   * rows written before that change still carry it and the column's CHECK
   * constraint still allows it — so the value stays in the vocabulary the UI
   * reads.
   */
  STUDENT_ID: 'student_id',
  ROLL_NUMBER: 'roll_number',
  NORMALIZED_NAME: 'normalized_name',
  FUZZY_NAME: 'fuzzy_name',
  MANUAL: 'manual',
  NONE: 'none',
} as const;

export type OcrMatchMethod = (typeof OCR_MATCH_METHOD)[keyof typeof OCR_MATCH_METHOD];

/** Accepted upload MIME types, checked server-side against magic bytes. */
export const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'image/webp',
] as const;

export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** Hard per-file upload ceiling (10 MiB) — enforced by the Storage bucket and re-checked server-side. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Users / students                                                            */
/* -------------------------------------------------------------------------- */

export const USER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const STUDENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  GRADUATED: 'graduated',
  TRANSFERRED: 'transferred',
} as const;

export type StudentStatus = (typeof STUDENT_STATUS)[keyof typeof STUDENT_STATUS];

export const GENDER = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
} as const;

export type Gender = (typeof GENDER)[keyof typeof GENDER];

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export const EXAM_STATUS = {
  SCHEDULED: 'scheduled',
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type ExamStatus = (typeof EXAM_STATUS)[keyof typeof EXAM_STATUS];

export const EXPORT_FORMAT = {
  CSV: 'csv',
  XLSX: 'xlsx',
  PDF: 'pdf',
  JSON: 'json',
} as const;

export type ExportFormat = (typeof EXPORT_FORMAT)[keyof typeof EXPORT_FORMAT];

export const IMPORT_STATUS = {
  PENDING: 'PENDING',
  VALIDATED: 'VALIDATED',
  IMPORTED: 'IMPORTED',
  FAILED: 'FAILED',
} as const;

export type ImportStatus = (typeof IMPORT_STATUS)[keyof typeof IMPORT_STATUS];

/**
 * Session lifetime, in hours.
 *
 * Clerk owns session duration now. Kept here only so the settings screen can
 * display the configured value; nothing in the application reads it. Changing it
 * means changing the Clerk instance, not this file.
 */
export const SESSION_TTL_HOURS = 12;

/**
 * Minimum password length.
 *
 * Advisory, for the hint on the password form. Clerk's password policy is
 * authoritative and enforced there: a stricter rule here would reject nothing,
 * and a looser one would mislead the user.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Max page size for any paginated endpoint. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const DATE_FORMAT = 'YYYY-MM-DD';