import { useQuery } from '@tanstack/react-query';
import {
  PERMISSIONS,
  type AdminDashboard,
  type TeacherDashboard,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { camelMany, QueryError, toQueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import { getCurrentAcademicYear, listClassSections } from '../../lib/repos/academic';
import { getAdminCounts, getRecentSubmissionsForTeacher, getTeacherSummary } from '../../lib/repos/admin';
import { getSubmissionCounts, listSubmissions } from '../../lib/repos/marks';
import { listOcrDocuments } from '../../lib/repos/storage';
import { getSupabase } from '../../lib/supabase';
import { formatRelative, pluralise } from '../../lib/utils';
import { SubmissionStatus, OcrStatusBadge } from '../../components/ui/Badge';
import { Alert, ErrorState, PanelSkeleton, Note } from '../../components/ui/States';
import { Button, LinkButton } from '../../components/ui/Button';
import {
  ActionList,
  Figure,
  FigureRow,
  Meter,
  PageHeader,
  SectionHeader,
  TitledPanel,
} from '../../components/ui/Layout';
import { StatusBarChart, GradeDistributionChart } from '../../components/charts/Charts';
import {
  IconCheck,
  IconEdit,
  IconEye,
  IconListChecks,
  IconScan,
  IconUsers,
} from '../../components/ui/icons';

/**
 * Dashboard.
 *
 * Structured around the four questions a user opens this screen to answer, in
 * priority order:
 *
 *   1. **What needs my attention?** — a task list, not a grid of counters.
 *   2. **What is the state of my work?** — a compact status strip.
 *   3. **What happened recently?** — a short activity list.
 *   4. **What can I do next?** — three or four shortcuts.
 *
 * Explicitly *not* a wall of KPI cards. Twelve coloured statistic tiles is the
 * clearest signal of a generated dashboard, and it is actively unhelpful: a
 * teacher does not need to be told they have 2 draft sheets in large orange type,
 * they need to be told *which* two and to be taken to them.
 *
 * The two views are assembled from the repository layer rather than a single
 * `dashboards/*` endpoint. Each number is read from the view or table that owns
 * it — the counts in `v_admin_counts`, the status tallies in `v_submissions`, the
 * teacher's own assignment summary — so a number can be traced to the row it
 * came from. Two aggregates have no repository function and are read here
 * instead: grade distribution and per-subject sheet coverage.
 */
export default function DashboardPage() {
  const { user } = useAuth();
  if (!user) return null;

  return can(user, PERMISSIONS.MARKS_VIEW_ALL) ? <AdminDashboardView /> : <TeacherDashboardView />;
}

/* ==========================================================================
   Teacher
   ========================================================================== */

function TeacherDashboardView() {
  const { user } = useAuth();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'teacher', user?.id],
    enabled: Boolean(user?.id),
    queryFn: (): Promise<TeacherDashboard> => loadTeacherDashboard(user?.id ?? ''),
  });

  if (isLoading) return <PanelSkeleton rows={6} className="max-w-3xl" />;

  if (error instanceof QueryError) {
    return (
      <ErrorState
        title="We could not load your dashboard"
        message={error.userMessage}
        hint="Your marks and assignments are unaffected. This is only the summary page."
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return null;

  const firstName = user?.fullName.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader
        title={`${firstName}'s marks`}
        description="Everything below is limited to the classes and subjects assigned to you."
        primaryAction={
          can(user, PERMISSIONS.MARKS_EDIT) ? (
            <LinkButton to="/app/marks" variant="primary" icon={<IconEdit size={15} />}>
              Enter marks
            </LinkButton>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 1 — the work queue. This is the panel the page exists for. */}
        <div className="lg:col-span-2">
          <TitledPanel
            title="Needs your attention"
            description="Draft sheets you have started, and sheets a reviewer returned for correction."
            actions={
              <span className="tabular text-xs text-ink-subtle">
                {data.pendingActions.length} open
              </span>
            }
          >
            {data.pendingActions.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-medium text-ink">Nothing is waiting for you</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">
                  You have no draft or returned mark sheets. When you start one it appears here
                  until you submit it.
                </p>
                {can(user, PERMISSIONS.MARKS_EDIT) && (
                  <LinkButton to="/app/marks" variant="primary" className="mt-3" icon={<IconEdit size={15} />}>
                    Enter marks
                  </LinkButton>
                )}
              </div>
            ) : (
              <ActionList
                items={data.pendingActions.map((action) => ({
                  id: action.submissionId,
                  title: `${action.subjectName} · ${action.examName}`,
                  meta: `Class ${action.sectionName} · ${action.enteredCount} of ${action.totalStudents} students entered`,
                  action: (
                    <LinkButton
                      to={`/app/marks?submissionId=${action.submissionId}`}
                      size="sm"
                      variant="secondary"
                    >
                      Continue
                    </LinkButton>
                  ),
                }))}
              />
            )}
          </TitledPanel>
        </div>

        {/* 2 — status at a glance, as a strip rather than a card grid. */}
        <div className="space-y-4">
          <PanelOfFigures
            title="Your work"
            items={[
              {
                label: 'In draft',
                value: data.draftSheets,
                tone: data.draftSheets > 0 ? 'warning' : 'neutral',
                hint: 'Not yet submitted',
              },
              {
                label: 'Awaiting review',
                value: data.submittedSheets,
                tone: 'accent',
                hint: 'With a reviewer',
              },
              {
                label: 'Returned to you',
                value: data.returnedSheets,
                tone: data.returnedSheets > 0 ? 'danger' : 'neutral',
                hint: data.returnedSheets > 0 ? 'Needs correction' : 'None',
              },
              {
                label: 'Approved',
                value: data.approvedSheets,
                tone: 'success',
                hint: 'Checked and accepted',
              },
            ]}
          />

          {data.pendingOcrReviews > 0 && (
            <TitledPanel
              title="OCR to verify"
              actions={
                <LinkButton to="/app/ocr" size="sm">
                  Review
                </LinkButton>
              }
            >
              <p className="text-sm text-ink-muted">
                {pluralise(data.pendingOcrReviews, 'document')} with extracted marks waiting for a
                person to check them. Nothing is saved until you confirm.
              </p>
              {data.processingOcrDocuments > 0 && (
                <Note className="mt-2">
                  {pluralise(data.processingOcrDocuments, 'document')} still being read.
                </Note>
              )}
            </TitledPanel>
          )}

          {can(user, PERMISSIONS.OCR_UPLOAD) && (
            <TitledPanel title="Digitise a mark sheet">
              <p className="text-sm text-ink-muted">
                Upload a photo or scan of a mark sheet to save typing. Extracted values are
                suggestions — you verify each one.
              </p>
              <LinkButton to="/app/ocr" className="mt-3" icon={<IconScan size={15} />}>
                Upload a mark sheet
              </LinkButton>
            </TitledPanel>
          )}
        </div>
      </div>

      {/* 3 — recent activity, so the user can orient after a break. */}
      {data.recentSubmissions.length > 0 && (
        <TitledPanel
          className="mt-4"
          title="Recently submitted"
          description="Your most recent mark sheets and where they are in the workflow."
        >
          <ActionList
            items={data.recentSubmissions.slice(0, 6).map((submission) => ({
              id: submission.id,
              title: `${submission.subjectName} · ${submission.examName}`,
              meta: `Class ${submission.className}-${submission.sectionName}`,
              status: <SubmissionStatus status={submission.status} />,
              action: (
                <LinkButton
                  to={`/app/marks?submissionId=${submission.id}`}
                  size="sm"
                  variant="ghost"
                  icon={<IconEye size={14} />}
                >
                  Open
                </LinkButton>
              ),
            }))}
          />
        </TitledPanel>
      )}
    </>
  );
}

/* ==========================================================================
   Admin / reviewer
   ========================================================================== */

function AdminDashboardView() {
  const { user } = useAuth();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'admin'],
    queryFn: (): Promise<AdminDashboard> => loadAdminDashboard(),
  });

  if (isLoading) return <PanelSkeleton rows={6} className="max-w-3xl" />;

  if (error instanceof QueryError) {
    return (
      <ErrorState
        title="We could not load the school overview"
        message={error.userMessage}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return null;

  const outstanding =
    data.pendingSubmissions + data.returnedSubmissions + data.ocrJobsFailed + data.ocrJobsPending;

  return (
    <>
      <PageHeader
        title="Examination progress"
        description={`Across ${data.totalClasses} classes and ${data.totalSections} sections. ${
          outstanding === 0
            ? 'Nothing is waiting on anyone.'
            : `${pluralise(outstanding, 'item')} need attention.`
        }`}
        primaryAction={
          can(user, PERMISSIONS.MARKS_REVIEW) && data.pendingSubmissions > 0 ? (
            <LinkButton to="/app/review" variant="primary" icon={<IconCheck size={15} />}>
              Review {pluralise(data.pendingSubmissions, 'sheet')}
            </LinkButton>
          ) : undefined
        }
      />

      {/* Failures first: they are the only thing here that needs acting today. */}
      {data.ocrJobsFailed > 0 && (
        <Alert
          tone="danger"
          title={`${pluralise(data.ocrJobsFailed, 'OCR document')} could not be read`}
          className="mb-4"
          action={
            can(user, PERMISSIONS.OCR_UPLOAD) ? (
              <LinkButton to="/app/ocr" size="sm">
                Open OCR
              </LinkButton>
            ) : undefined
          }
        >
          The mark sheet could not be processed. Retry it, or enter the marks by hand — nothing was
          saved.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 1 — what needs attention, expressed as work rather than counters. */}
        <TitledPanel
          className="lg:col-span-2"
          title="Waiting on someone"
          description="Grouped by who has to act next."
        >
          <ActionList
            items={[
              outstandingRow({
                id: 'review',
                count: data.pendingSubmissions,
                label: 'Mark sheets awaiting review',
                detail: 'Submitted by teachers, not yet checked.',
                to: '/app/review',
                cta: 'Review',
                visible: can(user, PERMISSIONS.MARKS_REVIEW),
                tone: 'warning',
              }),
              outstandingRow({
                id: 'returned',
                count: data.returnedSubmissions,
                label: 'Sheets returned for correction',
                detail: 'A reviewer sent these back to the teacher.',
                to: '/app/review',
                cta: 'View',
                visible: can(user, PERMISSIONS.MARKS_REVIEW),
                tone: 'danger',
              }),
              outstandingRow({
                id: 'ocr',
                count: data.ocrJobsPending,
                label: 'OCR documents being read',
                detail: 'Nothing to do until they finish.',
                to: '/app/ocr',
                cta: 'Open',
                visible: can(user, PERMISSIONS.OCR_VIEW_ASSIGNED),
                tone: 'accent',
              }),
              outstandingRow({
                id: 'ocr-failed',
                count: data.ocrJobsFailed,
                label: 'OCR documents failed',
                detail: 'Retry, or enter the marks by hand.',
                to: '/app/ocr',
                cta: 'Retry',
                visible: can(user, PERMISSIONS.OCR_UPLOAD),
                tone: 'danger',
              }),
            ].filter((item): item is NonNullable<typeof item> => item !== null)}
            emptyState={
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-medium text-ink">Nothing is waiting on anyone</p>
                <p className="mt-1 text-sm text-ink-muted">
                  Every submitted mark sheet has been reviewed.
                </p>
              </div>
            }
          />
        </TitledPanel>

        {/* 2 — the state of the whole examination, in one strip. */}
        <TitledPanel title="This examination" description="All mark sheets, all subjects.">
          <FigureRow
            className="grid-cols-2 lg:grid-cols-2 [&>*:not(:first-child)]:lg:border-l-0 [&>*:not(:first-child)]:lg:pl-0"
            items={[
              { label: 'Students', value: data.totalStudents.toLocaleString() },
              { label: 'Teachers', value: data.totalTeachers },
              { label: 'Classes', value: data.totalClasses, hint: `${data.totalSections} sections` },
              { label: 'Subjects', value: data.totalSubjects },
            ]}
          />

          <div className="mt-5 border-t border-line-soft pt-4">
            <Meter
              value={data.completionPercentage}
              label="Approved or locked"
              valueLabel={`${data.completionPercentage}%`}
              tone={data.completionPercentage === 100 ? 'success' : 'accent'}
            />
            <p className="mt-2 text-xs text-ink-subtle">
              {pluralise(data.approvedSubmissions, 'sheet')} approved and{' '}
              {pluralise(data.lockedSubmissions, 'sheet')} locked. Locked sheets are permanent
              records.
            </p>
          </div>
        </TitledPanel>
      </div>

      {/* 3 — two charts, each answering one question. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TitledPanel
          title="Where mark sheets are"
          description="Every sheet in the current academic year, by workflow state."
          bodyClassName="px-4 py-4"
        >
          {data.submissionsByStatus.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-muted">
              No mark sheets have been created yet.
            </p>
          ) : (
            <StatusBarChart data={data.submissionsByStatus} />
          )}
        </TitledPanel>

        <TitledPanel
          title="Grade distribution"
          description="Across every recorded mark. A useful check that grading is behaving."
          bodyClassName="px-4 py-4"
        >
          {data.gradeDistribution.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-muted">
              Grades appear here once marks have been entered.
            </p>
          ) : (
            <GradeDistributionChart data={data.gradeDistribution} />
          )}
        </TitledPanel>
      </div>

      {/* Subject coverage as a table, not a chart: these are exact counts. */}
      {data.subjectCoverage.length > 0 && (
        <TitledPanel
          className="mt-4"
          title="Coverage by subject"
          description="How many mark sheets exist for each subject. A subject with far fewer than its classmates is usually an assignment gap."
        >
          <table className="w-full text-sm">
            <thead className="bg-app-raised">
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  Subject
                </th>
                <th scope="col" className="w-32 px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  Mark sheets
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {data.subjectCoverage.map((entry) => (
                <tr key={entry.subjectCode}>
                  <td className="px-4 py-2">
                    <span className="text-ink">{entry.subjectName}</span>
                    <span className="tabular ml-2 text-xs text-ink-faint">{entry.subjectCode}</span>
                  </td>
                  <td className="tabular px-4 py-2 text-right text-ink">{entry.sheetCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TitledPanel>
      )}
    </>
  );
}

/* ==========================================================================
   Loaders
   ========================================================================== */

/**
 * Everything on a teacher's dashboard, scoped to them.
 *
 * `getSubmissionCounts()` is not filtered by teacher, but RLS on `v_submissions`
 * only exposes a teacher their own sheets, so the tallies are already theirs.
 * The OCR counts are not in `v_admin_counts`, so they are read per status here —
 * `listOcrDocuments` filters on one status at a time.
 */
async function loadTeacherDashboard(teacherId: string): Promise<TeacherDashboard> {
  const summary = await getTeacherSummary(teacherId);

  const [recentSubmissions, counts, openSheets, ocr, sections] = await Promise.all([
    getRecentSubmissionsForTeacher(teacherId),
    getSubmissionCounts(),
    // The sheets a teacher can still act on: their own drafts and returns.
    listSubmissions({ teacherId, status: 'DRAFT,RETURNED' }),
    loadTeacherOcrCounts(teacherId),
    listClassSections(summary[0]?.academicYearId ?? '').catch(() => []),
  ]);

  const sectionIds = new Set(summary.map((row) => row.sectionId));
  const subjectIds = new Set(summary.map((row) => row.subjectId));

  return {
    assignedClassCount: sectionIds.size,
    assignedSubjectCount: subjectIds.size,
    assignedStudentCount: sections
      .filter((section) => sectionIds.has(section.sectionId))
      .reduce((total, section) => total + section.studentCount, 0),
    draftSheets: summary.reduce((total, row) => total + row.drafts, 0),
    returnedSheets: summary.reduce((total, row) => total + row.returned, 0),
    submittedSheets: counts['SUBMITTED'] ?? 0,
    approvedSheets: counts['APPROVED'] ?? 0,
    pendingOcrReviews: ocr.pending,
    processingOcrDocuments: ocr.processing,
    recentSubmissions,
    pendingActions: openSheets.map((sheet) => ({
      submissionId: sheet.id,
      label: `${sheet.subjectName ?? ''} · ${sheet.examName ?? ''}`,
      examName: sheet.examName ?? '',
      subjectName: sheet.subjectName ?? '',
      sectionName: sheet.sectionName ?? '',
      enteredCount: sheet.enteredCount,
      totalStudents: sheet.totalStudents,
    })),
  };
}

/** Documents waiting for this teacher to verify, and ones still being read. */
async function loadTeacherOcrCounts(teacherId: string): Promise<{ pending: number; processing: number }> {
  const count = (status: string) =>
    listOcrDocuments({ page: 1, pageSize: 1, mine: teacherId, status }).then((page) => page.total);

  const [pending, uploaded, queued, processing] = await Promise.all([
    count('COMPLETED'),
    count('UPLOADED'),
    count('QUEUED'),
    count('PROCESSING'),
  ]);

  return { pending, processing: uploaded + queued + processing };
}

/**
 * The school-wide overview.
 *
 * `v_admin_counts` carries the head counts and the OCR failures; the workflow
 * tallies come from `v_submissions` via `getSubmissionCounts()`, which is also
 * what the status chart is built from so the two can never disagree.
 */
async function loadAdminDashboard(): Promise<AdminDashboard> {
  const [counts, statusCounts, totals, gradeDistribution, subjectCoverage] = await Promise.all([
    getAdminCounts(),
    getSubmissionCounts(),
    loadSchoolTotals(),
    loadGradeDistribution(),
    loadSubjectCoverage(),
  ]);

  const submissionsByStatus = Object.entries(statusCounts).map(([status, count]) => ({
    status: status as AdminDashboard['submissionsByStatus'][number]['status'],
    count,
  }));

  const approved = statusCounts['APPROVED'] ?? 0;
  const locked = statusCounts['LOCKED'] ?? 0;
  const total = counts.submissions;

  return {
    totalStudents: counts.students,
    totalTeachers: totals.teachers,
    totalClasses: totals.classes,
    totalSubjects: counts.subjects,
    totalSections: totals.sections,
    pendingSubmissions: statusCounts['SUBMITTED'] ?? 0,
    approvedSubmissions: approved,
    lockedSubmissions: locked,
    returnedSubmissions: statusCounts['RETURNED'] ?? 0,
    ocrJobsPending: counts.ocrPending,
    ocrJobsFailed: counts.ocrFailed,
    completionPercentage: total > 0 ? Math.round(((approved + locked) / total) * 100) : 0,
    submissionsByStatus,
    subjectCoverage,
    gradeDistribution,
  };
}

/**
 * Class and section counts for the current year, plus a teacher headcount.
 *
 * `v_admin_counts` reports every active profile as `active_users`, which is not
 * the same number as teachers — a reviewer or an administrator is an active
 * profile too — so the directory is counted directly by role instead.
 */
async function loadSchoolTotals(): Promise<{ classes: number; sections: number; teachers: number }> {
  const [year, teacherCount] = await Promise.all([
    getCurrentAcademicYear(),
    getSupabase()
      .from('v_directory')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'teacher')
      .eq('status', 'active')
      .then(({ count, error: failed }) => {
        if (failed) throw toQueryError(failed);
        return count ?? 0;
      }),
  ]);

  const sections = year ? await listClassSections(year.id) : [];

  return {
    classes: new Set(sections.map((section) => section.classId)).size,
    sections: sections.length,
    teachers: teacherCount,
  };
}

/**
 * Marks per grade, for the distribution chart.
 *
 * Page-local: no repository function exposes this, and it is a straight group-by
 * over `marks` — RLS still decides which rows the caller can see.
 */
async function loadGradeDistribution(): Promise<Array<{ grade: string; count: number }>> {
  const { data, error: failed } = await getSupabase().from('marks').select('grade').limit(20_000);
  if (failed) throw toQueryError(failed);

  const counts = new Map<string, number>();
  for (const row of camelMany<{ grade: string | null }>(data)) {
    if (!row.grade) continue;
    counts.set(row.grade, (counts.get(row.grade) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([grade, count]) => ({ grade, count }))
    .sort((a, b) => a.grade.localeCompare(b.grade));
}

/**
 * Mark sheets per subject, for the coverage table.
 *
 * Page-local for the same reason as the grade distribution: a subject with far
 * fewer sheets than its classmates is an assignment gap, and the table has to
 * show every subject, not the first page of them.
 */
async function loadSubjectCoverage(): Promise<Array<{ subjectName: string; subjectCode: string; sheetCount: number }>> {
  const { data, error: failed } = await getSupabase()
    .from('v_submissions')
    .select('subject_id, subject_name, subject_code')
    .limit(20_000);
  if (failed) throw toQueryError(failed);

  const bySubject = new Map<string, { subjectName: string; subjectCode: string; sheetCount: number }>();
  for (const row of camelMany<{ subjectId: string; subjectName: string | null; subjectCode: string | null }>(data)) {
    const entry = bySubject.get(row.subjectId);
    if (entry) {
      entry.sheetCount += 1;
      continue;
    }
    bySubject.set(row.subjectId, {
      subjectName: row.subjectName ?? '',
      subjectCode: row.subjectCode ?? '',
      sheetCount: 1,
    });
  }

  return [...bySubject.values()].sort((a, b) => b.sheetCount - a.sheetCount);
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/**
 * A "waiting on someone" row.
 *
 * Rows with a zero count are omitted entirely: a dashboard that lists four
 * things and then says three are zero is three rows of noise.
 */
function outstandingRow({
  id,
  count,
  label,
  detail,
  to,
  cta,
  visible,
  tone,
}: {
  id: string;
  count: number;
  label: string;
  detail: string;
  to: string;
  cta: string;
  visible: boolean;
  tone: 'warning' | 'danger' | 'accent';
}) {
  if (!visible || count === 0) return null;

  return {
    id,
    title: `${count} · ${label}`,
    meta: detail,
    status: (
      <span
        className="sr-only"
      >
        {tone === 'danger' ? 'Needs attention. ' : tone === 'warning' ? 'In progress. ' : 'Automatic. '}
      </span>
    ),
    action: (
      <LinkButton to={to} size="sm">
        {cta}
      </LinkButton>
    ),
  };
}

/** A title plus a strip of figures — the replacement for a KPI card row. */
function PanelOfFigures({
  title,
  items,
}: {
  title: string;
  items: Array<React.ComponentProps<typeof Figure>>;
}) {
  return (
    <TitledPanel title={title}>
      <FigureRow className="grid-cols-2 lg:grid-cols-2 [&>*:not(:first-child)]:lg:border-l-0 [&>*:not(:first-child)]:lg:pl-0" items={items} />
    </TitledPanel>
  );
}
