import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth as useClerkAuth } from '@clerk/react';
import { PERMISSIONS, type Permission } from '@school/shared';
import { SignInOpener, SignUpOpener } from './components/auth/ClerkModals';
import { useAuth } from './lib/auth';
import { can } from './lib/permissions';
import { SCHOOL } from './lib/school';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { LoadingState, NoAccessState } from './components/ui/States';
import { AppLayout } from './components/layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { AccountUnavailablePage } from './pages/AccountUnavailablePage';

/**
 * Routes are code-split per feature area. A teacher who only enters marks never
 * downloads the audit-log or report code — on a school's slow connection that
 * is the difference between a fast first load and a frustrating one.
 */
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const MarksEntryPage = lazy(() => import('./pages/marks/MarksEntryPage'));
const ReviewQueuePage = lazy(() => import('./pages/review/ReviewQueuePage'));
const SubmissionDetailPage = lazy(() => import('./pages/review/SubmissionDetailPage'));
const OcrUploadPage = lazy(() => import('./pages/ocr/OcrUploadPage'));
const OcrReviewPage = lazy(() => import('./pages/ocr/OcrReviewPage'));
const StudentsPage = lazy(() => import('./pages/students/StudentsPage'));
const StudentDetailPage = lazy(() => import('./pages/students/StudentDetailPage'));
const StudentImportPage = lazy(() => import('./pages/students/StudentImportPage'));
const TeachersPage = lazy(() => import('./pages/admin/TeachersPage'));
const AcademicYearsPage = lazy(() => import('./pages/admin/AcademicYearsPage'));
const ClassesPage = lazy(() => import('./pages/admin/ClassesPage'));
const SubjectsPage = lazy(() => import('./pages/admin/SubjectsPage'));
const ExamsPage = lazy(() => import('./pages/admin/ExamsPage'));
const AssignmentsPage = lazy(() => import('./pages/admin/AssignmentsPage'));
const ClassRequestsPage = lazy(() => import('./pages/admin/ClassRequestsPage'));
const GradingPage = lazy(() => import('./pages/admin/GradingPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const ExportsPage = lazy(() => import('./pages/reports/ExportsPage'));
const AuditLogPage = lazy(() => import('./pages/admin/AuditLogPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const DatabasePage = lazy(() => import('./pages/admin/DatabasePage'));
const ProfilePage = lazy(() => import('./pages/account/ProfilePage'));
const MyClassesPage = lazy(() => import('./pages/MyClassesPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

/**
 * Blocks the authenticated app until Clerk has a session AND Postgres has an
 * active `profiles` row for that user.
 *
 * Four states, not two. The third and fourth exist because a Clerk account and
 * a school account are not the same thing: a user can be perfectly valid in
 * Clerk and still be unprovisioned or deactivated in the database. Redirecting
 * those to the sign-in screen would produce an infinite loop, because signing in
 * again would not change the answer.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }

  if (status === 'anonymous') {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }

  if (status === 'unprovisioned') {
    return <AccountUnavailablePage />;
  }

  // NOTE: the old ForcePasswordChangeGate is intentionally gone. It existed to
  // block users who had been issued an admin-set temporary password; Clerk owns
  // password policy and resets now, so there is no such flag to check.
  //
  // This renders `children` (the <AppLayout /> element the route passes in) and
  // nothing else. The previous implementation ignored `children` and constructed
  // its own <AppLayout />, which worked only because AppLayout renders an
  // <Outlet /> for the nested routes.
  return <>{children}</>;
}

/**
 * Blocks a route the current role holds no permission for.
 *
 * Every gated page was already hidden from the navigation by `NAVIGATION` in
 * `lib/permissions`, and that is all it was: hiding a link is not a route guard.
 * A typed URL, a bookmark, a stale tab or the browser's back button all reach the
 * route anyway, and the page then fetches rows RLS refuses to return and renders
 * an empty screen that reads as broken rather than as forbidden. `/app/teachers`
 * was the clearest case, but it was not a special case — every setup, insight and
 * people route below was in the same position.
 *
 * This is a usability gate and never a security one: RLS is still what decides
 * whether any row comes back, and a direct PostgREST call ignores this entirely.
 * It reads the same `PERMISSIONS` constant the navigation does, so a link that is
 * visible leads to a page that is permitted, and the two cannot drift.
 */
function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { user } = useAuth();
  return user && can(user, permission) ? <>{children}</> : <NoAccessState />;
}

/**
 * Shorthand for gating a route element: `element={gate(PERMISSIONS.X, <Page />)}`.
 *
 * The page element is built either way but never rendered when access is denied,
 * so a lazy route is still not downloaded by someone who cannot open it.
 */
function gate(permission: Permission, element: ReactNode) {
  return <RequirePermission permission={permission}>{element}</RequirePermission>;
}

/**
 * Keeps the document title in sync with the route.
 *
 * The suffix is the school name rather than a generic "School Marks Management".
 * The title bar is the one piece of this application a teacher sees outside the
 * browser chrome — in a bookmark, in a tab list with nine other school tabs open,
 * or pasted into a message — so it has to say which school it belongs to.
 *
 * The landing page gets the full identity, because a bookmarked front door with
 * no route segment should read as the school, not as a product.
 */
function useDocumentTitle() {
  const location = useLocation();
  useEffect(() => {
    const segment = location.pathname.split('/').filter(Boolean).pop();
    document.title = segment
      ? `${segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} · ${SCHOOL.shortName}`
      : `${SCHOOL.name} · Marks Management`;
  }, [location.pathname]);
}

export function App() {
  useDocumentTitle();

  return (
    <ErrorBoundary label="The application">
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center">
            <LoadingState label="Loading…" />
          </div>
        }
      >
        <Routes>
        {/* ---------------------------------------------------------------- */}
        {/* Public                                                          */}
        {/* ---------------------------------------------------------------- */}
        <Route path="/" element={<HomePage />} />

        {/* Clerk owns the entire sign-in / sign-up journey.
            These open Clerk's UI imperatively rather than rendering
            `<SignIn routing="path">`, which rendered an empty div in this app —
            see ClerkModals.tsx for the evidence. The URLs still work, so old
            bookmarks and the /login redirects below continue to resolve. */}
        <Route path="/sign-in/*" element={<SignInOpener />} />
        <Route path="/sign-up/*" element={<SignUpOpener />} />

        {/* Convenience redirect for bookmarks to the old bespoke login screen. */}
        <Route path="/login" element={<Navigate to="/sign-in" replace />} />
        <Route path="/forgot-password" element={<Navigate to="/sign-in" replace />} />
        <Route path="/reset-password" element={<Navigate to="/sign-in" replace />} />

        {/* ---------------------------------------------------------------- */}
        {/* Authenticated shell                                             */}
        {/* ---------------------------------------------------------------- */}
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />

          {/* Self-service. Available to any signed-in account, because the whole
              point is that a new teacher can start without an admin. */}
          <Route path="my-classes" element={<MyClassesPage />} />

          <Route
            path="marks"
            element={gate(PERMISSIONS.MARKS_EDIT, <MarksEntryPage />)}
          />
          <Route
            path="marks/:submissionId"
            element={gate(PERMISSIONS.MARKS_EDIT, <MarksEntryPage />)}
          />

          <Route
            path="review"
            element={gate(PERMISSIONS.MARKS_REVIEW, <ReviewQueuePage />)}
          />
          <Route
            path="review/:submissionId"
            element={gate(PERMISSIONS.MARKS_REVIEW, <SubmissionDetailPage />)}
          />

          <Route path="ocr" element={gate(PERMISSIONS.OCR_VIEW_ASSIGNED, <OcrUploadPage />)} />
          <Route
            path="ocr/:documentId"
            element={gate(PERMISSIONS.OCR_VIEW_ASSIGNED, <OcrReviewPage />)}
          />

          <Route path="students" element={gate(PERMISSIONS.STUDENT_VIEW, <StudentsPage />)} />
          <Route
            path="students/import"
            element={gate(PERMISSIONS.STUDENT_IMPORT, <StudentImportPage />)}
          />
          <Route
            path="students/:studentId"
            element={gate(PERMISSIONS.STUDENT_VIEW, <StudentDetailPage />)}
          />

          <Route path="teachers" element={gate(PERMISSIONS.USER_LIST, <TeachersPage />)} />

          <Route
            path="academic-years"
            element={gate(PERMISSIONS.ACADEMIC_YEAR_MANAGE, <AcademicYearsPage />)}
          />
          <Route path="classes" element={gate(PERMISSIONS.CLASS_MANAGE, <ClassesPage />)} />
          <Route path="subjects" element={gate(PERMISSIONS.SUBJECT_MANAGE, <SubjectsPage />)} />
          <Route path="exams" element={gate(PERMISSIONS.EXAM_MANAGE, <ExamsPage />)} />
          <Route
            path="assignments"
            element={gate(PERMISSIONS.ASSIGNMENT_MANAGE, <AssignmentsPage />)}
          />
          <Route
            path="class-requests"
            element={gate(PERMISSIONS.ASSIGNMENT_DECIDE, <ClassRequestsPage />)}
          />
          <Route path="grading" element={gate(PERMISSIONS.GRADING_MANAGE, <GradingPage />)} />

          <Route
            path="reports"
            element={gate(PERMISSIONS.REPORT_VIEW_ASSIGNED, <ReportsPage />)}
          />
          <Route path="exports" element={gate(PERMISSIONS.EXPORT_CREATE, <ExportsPage />)} />
          <Route path="audit" element={gate(PERMISSIONS.AUDIT_LOG_VIEW, <AuditLogPage />)} />
          <Route path="settings" element={gate(PERMISSIONS.SETTINGS_MANAGE, <SettingsPage />)} />
          <Route path="database" element={gate(PERMISSIONS.SETTINGS_MANAGE, <DatabasePage />)} />

          <Route path="profile" element={<ProfilePage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}