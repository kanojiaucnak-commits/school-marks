import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MARK_STATUS,
  PERMISSIONS,
  SUBMISSION_STATUS,
  type MarkEntryRow,
  type SubmissionStatus,
} from '@school/shared';
import { getMarksGrid, getSubmission, lockSheet } from '../../lib/repos/marks';
import { downloadFromUrl } from '../../lib/repos/storage';
import { edgeFetch } from '../../lib/edge';
import { QueryError, toQueryError } from '../../lib/query';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { SUBMISSION_STATUS_STYLES, formatDateTime, formatMark } from '../../lib/utils';
import { Badge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { Card, CardHeader, StatTile } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { IconDownload, IconLock } from '../../components/ui/icons';

/**
 * Review a single mark sheet.
 *
 * Read-only by design: a reviewer inspects the marks and records a decision.
 * Correcting an individual value is a separate, audited action reachable from a
 * locked sheet, not something a reviewer can do inline.
 */
export default function SubmissionDetailPage() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { success, error: errorToast } = useToast();

  const [lockOpen, setLockOpen] = useState(false);
  const [lockComments, setLockComments] = useState('');

  const { data: submission, isLoading, error, refetch } = useQuery({
    queryKey: ['submissions', submissionId],
    queryFn: async () => {
      const found = await getSubmission(submissionId);
      if (!found) throw new QueryError('PGRST116', 'That record could not be found.');
      return found;
    },
    enabled: Boolean(submissionId),
  });

  const { data: grid, isLoading: gridLoading } = useQuery({
    queryKey: [
      'marks',
      'grid',
      submission?.academicYearId,
      submission?.sectionId,
      submission?.subjectId,
      submission?.examId,
    ],
    queryFn: () =>
      getMarksGrid({
        academicYearId: submission?.academicYearId ?? '',
        classId: submission?.classId ?? '',
        sectionId: submission?.sectionId ?? '',
        subjectId: submission?.subjectId ?? '',
        examId: submission?.examId ?? '',
      }),
    enabled: Boolean(submission),
  });

  /** Counters for the stat tiles, taken from the same rows as the table below. */
  const stats = useMemo(() => summariseSheet(grid?.rows), [grid?.rows]);

  const lock = useMutation({
    mutationFn: () =>
      lockSheet(
        submissionId,
        submission?.version ?? null,
        // An empty note would blank the approver's comment: the transition
        // coalesces its argument rather than ignoring an empty string.
        lockComments.trim() || undefined,
      ),
    onSuccess: () => {
      setLockOpen(false);
      setLockComments('');
      success('Marks locked', 'These marks are now a permanent record.');
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
      void queryClient.invalidateQueries({ queryKey: ['marks'] });
    },
    onError: (caught) => {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not lock these marks.');
    },
  });

  const [exporting, setExporting] = useState(false);

  /** Download this exact sheet as CSV — the most common "take it away" action. */
  const handleExport = async () => {
    if (!submission) return;
    setExporting(true);
    try {
      const result = await edgeFetch<{
        job: { id: string; storage_path: string | null } | null;
        queued: boolean;
        message: string;
      }>('export-generate', {
        method: 'POST',
        body: {
          kind: 'marks',
          format: 'csv',
          params: {
            academicYearId: submission.academicYearId,
            classId: submission.classId,
            sectionId: submission.sectionId,
            subjectId: submission.subjectId,
            examId: submission.examId,
          },
        },
      });

      // Nothing is queued any more, so a missing path means the job did not complete
      // rather than "it will appear shortly".
      if (!result.job?.storage_path) {
        throw new QueryError(
          'EXPORT_FAILED',
          'The export did not produce a file. Try again, or use the exports page for details.',
        );
      }

      // The function stores the file in a private bucket and returns the path,
      // not a URL. Asking the function for the job's own signed URL rather than
      // minting one here: Supabase Storage verifies bearer tokens the same way
      // PostgREST does, so a Clerk token cannot reach it directly. `export-download`
      // already performs the permission check and the signing in one step.
      const signed = await edgeFetch<{ url: string }>('export-download', {
        method: 'POST',
        body: { jobId: result.job.id },
      });
      if (!signed?.url) {
        throw new QueryError('DOWNLOAD_FAILED', 'The download could not be started.');
      }

      await downloadFromUrl(signed.url, `marks-${submission.subjectCode ?? 'sheet'}.csv`);
      success('Export downloaded');
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  if (isLoading) return <LoadingState label="Loading mark sheet…" />;

  if (error instanceof QueryError) {
    return (
      <div className="space-y-4">
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
        <Button onClick={() => navigate('/app/review')}>Back to the queue</Button>
      </div>
    );
  }

  if (!submission) return null;

  const style = SUBMISSION_STATUS_STYLES[submission.status as SubmissionStatus];
  const canLock =
    can(user, PERMISSIONS.MARKS_LOCK) && submission.status === SUBMISSION_STATUS.APPROVED;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">
            Class {submission.className}-{submission.sectionName} · Subject {submission.subjectCode} ·
            entered by {submission.teacherName}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge className={style.className} dotClassName={style.dotClassName}>
            {style.label}
          </Badge>
          <Button
            size="sm"
            icon={<IconDownload size={14} />}
            loading={exporting}
            onClick={handleExport}
            title="Download this mark sheet as CSV"
          >
            Export
          </Button>
          {canLock && (
            <Button
              variant="primary"
              size="sm"
              icon={<IconLock size={14} />}
              onClick={() => setLockOpen(true)}
            >
              Lock marks
            </Button>
          )}
          <LinkButton to="/app/review" size="sm">
            Back to queue
          </LinkButton>
        </div>
      </header>

      {submission.reviewComments && (
        <Alert tone="info" title="Reviewer comment">
          {submission.reviewComments}
        </Alert>
      )}

      {submission.status === SUBMISSION_STATUS.LOCKED && (
        <Alert tone="info" title="These marks are locked">
          A locked sheet cannot be edited. If a correction is genuinely required, an administrator
          must use the audited correction flow, which records the old value, new value, reason and
          user.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Students" value={submission.totalStudents} />
        <StatTile label="With marks" value={stats.entered} tone="accent" />
        <StatTile label="Average" value={formatMark(stats.average)} />
        <StatTile
          label="Highest"
          value={formatMark(stats.highest)}
          hint={`Lowest ${formatMark(stats.lowest)}`}
        />
        <StatTile
          label="Absent / exempt"
          value={`${stats.absent} / ${stats.exempted}`}
          hint={`${stats.medical} medical`}
        />
      </div>

      <dl className="grid gap-x-6 gap-y-3 rounded-xl border border-line bg-surface p-5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Submitted</dt>
          <dd className="tabular mt-0.5 text-ink">
            {formatDateTime(submission.submittedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Approved</dt>
          <dd className="tabular mt-0.5 text-ink">
            {formatDateTime(submission.approvedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Locked</dt>
          <dd className="tabular mt-0.5 text-ink">
            {formatDateTime(submission.lockedAt)}
          </dd>
        </div>
      </dl>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader title="Marks" description={`Maximum marks: ${grid?.maxMarks ?? '—'}`} />
        </div>

        {gridLoading || !grid ? (
          <LoadingState label="Loading marks…" />
        ) : grid.rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No marks on this sheet" icon="📝" />
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Marks for {submission.subjectName}</caption>
              <thead className="border-y border-line bg-surface-muted">
                <tr>
                  <th scope="col" className="w-16 px-3 py-2 text-xs font-semibold uppercase text-ink-muted">
                    Roll
                  </th>
                  <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase text-ink-muted">
                    Student
                  </th>
                  <th scope="col" className="w-24 px-3 py-2 text-right text-xs font-semibold uppercase text-ink-muted">
                    Marks
                  </th>
                  <th scope="col" className="w-24 px-3 py-2 text-center text-xs font-semibold uppercase text-ink-muted">
                    Grade
                  </th>
                  <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase text-ink-muted">
                    Remarks
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {grid.rows.map((row) => (
                  <tr key={row.studentId} className="hover:bg-surface-muted">
                    <td className="tabular px-3 py-2 text-right text-ink-muted">
                      {row.rollNumber ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-ink">{row.fullName}</p>
                      <p className="tabular text-xs text-ink-subtle">{row.studentNumber}</p>
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {row.status !== 'PRESENT' ? (
                        <Badge className="bg-surface-sunken text-ink ring-line-strong">
                          {row.status}
                        </Badge>
                      ) : (
                        <span className="text-ink">{formatMark(row.marksObtained)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {row.grade ? (
                        <span className="tabular font-medium text-ink">{row.grade}</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{row.remarks ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Lock confirmation */}
      <Modal
        open={lockOpen}
        onClose={() => setLockOpen(false)}
        title="Lock these marks"
        description="Locking is final. After this, only an audited correction with a written reason can change a mark."
        busy={lock.isPending}
        footer={
          <>
            <Button onClick={() => setLockOpen(false)} disabled={lock.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={lock.isPending} onClick={() => lock.mutate()}>
              Lock marks
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" title="This cannot be undone">
            Locked marks become a permanent academic record. Confirm that the marks on this sheet are
            correct and approved by the school.
          </Alert>
          <label htmlFor="lock-comments" className="block text-sm font-medium text-ink">
            Note for the record (optional)
          </label>
          <textarea
            id="lock-comments"
            value={lockComments}
            onChange={(event) => setLockComments(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

interface SheetSummary {
  entered: number;
  average: number | null;
  highest: number | null;
  lowest: number | null;
  absent: number;
  exempted: number;
  medical: number;
}

/**
 * Sheet counters derived from the grid rows.
 *
 * The submission row carries its own `entered_count` and `average_marks`, but
 * those are only refreshed when the sheet is saved; a reviewer looking at a
 * rejected sheet that the teacher never re-saved would be shown stale numbers.
 */
function summariseSheet(rows: MarkEntryRow[] | undefined): SheetSummary {
  const all = rows ?? [];
  const scored = all
    .filter((row) => row.status === MARK_STATUS.PRESENT && row.marksObtained !== null)
    .map((row) => Number(row.marksObtained));

  const count = (status: string) => all.filter((row) => row.status === status).length;

  return {
    entered: scored.length,
    average: scored.length ? round2(sum(scored) / scored.length) : null,
    highest: scored.length ? Math.max(...scored) : null,
    lowest: scored.length ? Math.min(...scored) : null,
    absent: count(MARK_STATUS.ABSENT),
    exempted: count(MARK_STATUS.EXEMPTED),
    medical: count(MARK_STATUS.MEDICAL),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Matches the two decimal places `formatMark` renders. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
