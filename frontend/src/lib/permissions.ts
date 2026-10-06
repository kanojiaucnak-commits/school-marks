import { PERMISSIONS, type CurrentUser, type Permission } from '@school/shared';

/**
 * Pure client-side permission helper.
 *
 * This exists purely to decide what to *render*. Postgres RLS is the enforcement
 * boundary — a hidden button is a usability feature, never a security control.
 *
 * `canAll`, `canAny`, `isAdmin` and `reviewsMarks` used to live here too. They were
 * removed as dead code: each had no callers, and role checks were the more likely
 * of the two to go stale. Use `can()` with an explicit permission instead — it is
 * answered by the same list RLS reads, so it cannot disagree with the database.
 */
export function can(user: CurrentUser | null | undefined, permission: Permission): boolean {
  return Boolean(user?.permissions.includes(permission));
}

/* -------------------------------------------------------------------------- */
/* Role helpers                                                                */
/* -------------------------------------------------------------------------- */

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  teacher: 'Teacher',
  reviewer: 'Reviewer / Principal',
};

export function roleLabel(role: string | undefined): string {
  return role ? (ROLE_LABELS[role] ?? role) : '—';
}

/** The navigation the current role should see. */
export interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission?: Permission;
  roles?: string[];
  end?: boolean;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

/**
 * Single source of truth for navigation. Filtering happens here so a new role
 * never sees a page it cannot use, and every entry declares the permission it
 * requires (kept aligned with the RLS policies by `permissions.seed.test.ts`).
 */
export const NAVIGATION: NavSection[] = [
  {
    heading: 'Overview',
    items: [
      { to: '/app', label: 'Dashboard', icon: 'home', end: true },
      // No permission gate: this is how a new teacher asks for access, so gating it
      // behind `assignment:request` would hide it from exactly the people who need
      // it. The page itself is inert without an approved assignment.
      { to: '/app/my-classes', label: 'My classes', icon: 'link' },
      { to: '/app/marks', label: 'Enter marks', icon: 'edit', permission: PERMISSIONS.MARKS_EDIT },
      { to: '/app/review', label: 'Review queue', icon: 'check', permission: PERMISSIONS.MARKS_REVIEW },
      { to: '/app/ocr', label: 'OCR uploads', icon: 'scan', permission: PERMISSIONS.OCR_VIEW_ASSIGNED },
    ],
  },
  {
    heading: 'People',
    items: [
      { to: '/app/students', label: 'Students', icon: 'users', permission: PERMISSIONS.STUDENT_VIEW },
      { to: '/app/students/import', label: 'Import students', icon: 'upload', permission: PERMISSIONS.STUDENT_IMPORT },
      { to: '/app/teachers', label: 'Teachers', icon: 'user', permission: PERMISSIONS.USER_LIST },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { to: '/app/academic-years', label: 'Academic years', icon: 'calendar', permission: PERMISSIONS.ACADEMIC_YEAR_MANAGE },
      { to: '/app/classes', label: 'Classes & sections', icon: 'grid', permission: PERMISSIONS.CLASS_MANAGE },
      { to: '/app/subjects', label: 'Subjects', icon: 'book', permission: PERMISSIONS.SUBJECT_MANAGE },
      { to: '/app/exams', label: 'Exams', icon: 'clipboard', permission: PERMISSIONS.EXAM_MANAGE },
      { to: '/app/assignments', label: 'Teacher assignments', icon: 'link', permission: PERMISSIONS.ASSIGNMENT_MANAGE },
      { to: '/app/class-requests', label: 'Class requests', icon: 'inbox', permission: PERMISSIONS.ASSIGNMENT_DECIDE },
      { to: '/app/grading', label: 'Grading schemes', icon: 'award', permission: PERMISSIONS.GRADING_MANAGE },
    ],
  },
  {
    heading: 'Insight',
    items: [
      { to: '/app/reports', label: 'Reports', icon: 'chart', permission: PERMISSIONS.REPORT_VIEW_ASSIGNED },
      { to: '/app/exports', label: 'Exports', icon: 'download', permission: PERMISSIONS.EXPORT_CREATE },
      { to: '/app/audit', label: 'Audit log', icon: 'shield', permission: PERMISSIONS.AUDIT_LOG_VIEW },
      { to: '/app/settings', label: 'Settings', icon: 'cog', permission: PERMISSIONS.SETTINGS_MANAGE },
      { to: '/app/database', label: 'Database', icon: 'database', permission: PERMISSIONS.SETTINGS_MANAGE },
    ],
  },
];

export function navigationFor(user: CurrentUser | null | undefined): NavSection[] {
  if (!user) return [];
  return NAVIGATION.map((section) => ({
    heading: section.heading,
    items: section.items.filter(
      (item) => !item.permission || can(user, item.permission),
    ),
  })).filter((section) => section.items.length > 0);
}