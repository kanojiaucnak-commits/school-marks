/**
 * Permission catalogue.
 *
 * Every permission is enforced in Postgres, by the RLS policies in
 * `supabase/migrations/0002_rls.sql`. The frontend uses this same list purely to
 * decide what to *render* — it is never the enforcement boundary
 * (Business Rule 8), and `shared/tests/permissions.seed.test.ts` keeps the two
 * copies from drifting.
 */

import { ALL_ROLES, ROLES, type Role } from './constants.js';

export const PERMISSIONS = {
  /* Users / teachers */
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_LIST: 'user:list',

  /* Academic structure */
  ACADEMIC_YEAR_MANAGE: 'academic_year:manage',
  CLASS_MANAGE: 'class:manage',
  SECTION_MANAGE: 'section:manage',
  SUBJECT_MANAGE: 'subject:manage',
  EXAM_MANAGE: 'exam:manage',
  ASSIGNMENT_MANAGE: 'assignment:manage',
  /** Ask to be given classes to teach. Held by teachers, so they can self-serve. */
  ASSIGNMENT_REQUEST: 'assignment:request',
  /** Approve or reject those requests. Held by admins only. */
  ASSIGNMENT_DECIDE: 'assignment:decide',

  /* Students */
  STUDENT_CREATE: 'student:create',
  STUDENT_UPDATE: 'student:update',
  STUDENT_DELETE: 'student:delete',
  /**
   * The school-wide roster. Admin and reviewer only.
   *
   * `STUDENT_VIEW` deliberately does NOT mean the whole school: it is scoped to
   * the sections a teacher is assigned to. That split matters because accounts
   * can now be created by anyone who signs up, so a single school-wide read
   * permission would hand the entire roster to any self-registered account.
   */
  STUDENT_VIEW_ALL: 'student:view_all',
  /** Students in the caller's assigned sections. */
  STUDENT_VIEW: 'student:view',
  STUDENT_IMPORT: 'student:import',
  STUDENT_EXPORT: 'student:export',

  /* Marks */
  MARKS_VIEW_ASSIGNED: 'marks:view_assigned',
  MARKS_VIEW_ALL: 'marks:view_all',
  MARKS_EDIT: 'marks:edit',
  MARKS_CORRECT_LOCKED: 'marks:correct_locked',
  MARKS_SUBMIT: 'marks:submit',
  MARKS_REVIEW: 'marks:review',
  MARKS_APPROVE: 'marks:approve',
  MARKS_REJECT: 'marks:reject',
  MARKS_LOCK: 'marks:lock',

  /* Grading */
  GRADING_MANAGE: 'grading:manage',
  GRADING_VIEW: 'grading:view',

  /* OCR */
  OCR_UPLOAD: 'ocr:upload',
  OCR_REVIEW: 'ocr:review',
  OCR_CONFIRM: 'ocr:confirm',
  OCR_VIEW_ASSIGNED: 'ocr:view_assigned',
  OCR_VIEW_ALL: 'ocr:view_all',

  /* Reports & export */
  REPORT_VIEW_ASSIGNED: 'report:view_assigned',
  REPORT_VIEW_ALL: 'report:view_all',
  EXPORT_CREATE: 'export:create',

  /* Admin surfaces */
  AUDIT_LOG_VIEW: 'audit_log:view',
  SETTINGS_MANAGE: 'settings:manage',
  NOTIFICATION_VIEW: 'notification:view',

  /* Imports */
  IMPORT_MANAGE: 'import:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const TEACHER_PERMISSIONS: Permission[] = [
  PERMISSIONS.USER_UPDATE, // own profile only — scope enforced separately
  PERMISSIONS.STUDENT_VIEW,
  // Enrol a mid-year joiner. The permission alone would allow any section, so
  // `students_insert` additionally requires the target section to be one the
  // teacher is assigned to or teaches (see 0023_teacher_student_create.sql).
  PERMISSIONS.STUDENT_CREATE,
  PERMISSIONS.MARKS_VIEW_ASSIGNED,
  PERMISSIONS.MARKS_EDIT,
  PERMISSIONS.MARKS_SUBMIT,
  PERMISSIONS.OCR_UPLOAD,
  PERMISSIONS.OCR_REVIEW,
  PERMISSIONS.OCR_CONFIRM,
  PERMISSIONS.OCR_VIEW_ASSIGNED,
  PERMISSIONS.REPORT_VIEW_ASSIGNED,
  PERMISSIONS.EXPORT_CREATE,
  PERMISSIONS.GRADING_VIEW,
  PERMISSIONS.NOTIFICATION_VIEW,
  PERMISSIONS.STUDENT_EXPORT,
  PERMISSIONS.ASSIGNMENT_REQUEST,
];

const REVIEWER_PERMISSIONS: Permission[] = [
  PERMISSIONS.USER_LIST,
  PERMISSIONS.STUDENT_VIEW,
  PERMISSIONS.STUDENT_EXPORT,
  PERMISSIONS.MARKS_VIEW_ALL,
  PERMISSIONS.MARKS_REVIEW,
  PERMISSIONS.MARKS_APPROVE,
  PERMISSIONS.MARKS_REJECT,
  PERMISSIONS.MARKS_LOCK,
  PERMISSIONS.MARKS_CORRECT_LOCKED,
  PERMISSIONS.REPORT_VIEW_ALL,
  PERMISSIONS.EXPORT_CREATE,
  PERMISSIONS.GRADING_VIEW,
  PERMISSIONS.GRADING_MANAGE,
  PERMISSIONS.NOTIFICATION_VIEW,
  PERMISSIONS.OCR_VIEW_ALL,
  PERMISSIONS.STUDENT_IMPORT,
  PERMISSIONS.STUDENT_VIEW_ALL,
];

/**
 * Admin holds everything except `assignment:request`.
 *
 * This used to be `Object.values(PERMISSIONS)`, on the assumption that admin is
 * all-powerful. That assumption is now wrong in a way that would have failed
 * silently: an admin could ask for classes to be taught, which is meaningless
 * because `assignment:manage` already lets them assign anyone to anything
 * directly. Listing the permissions out means the exception is visible in a
 * review instead of hiding in an invariant.
 */
/**
 * Permissions deliberately withheld from the admin role.
 *
 * Admin holds every permission except these. The list is exported so the
 * seed-parity test can assert the same exception instead of the old blanket
 * "admin has everything" rule, which no longer holds.
 */
export const ADMIN_PERMISSION_EXEMPTIONS: readonly Permission[] = [
  PERMISSIONS.ASSIGNMENT_REQUEST,
];

const ADMIN_PERMISSIONS: Permission[] = Object.values(PERMISSIONS).filter(
  (permission) => !ADMIN_PERMISSION_EXEMPTIONS.includes(permission),
);

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.ADMIN]: ADMIN_PERMISSIONS,
  [ROLES.REVIEWER]: REVIEWER_PERMISSIONS,
  [ROLES.TEACHER]: TEACHER_PERMISSIONS,
};

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export function rolesWithPermission(permission: Permission): Role[] {
  return ALL_ROLES.filter((role) => roleHasPermission(role, permission));
}