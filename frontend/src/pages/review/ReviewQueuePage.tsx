import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SUBMISSION_STATUS,
  type MarkSubmission,
  type SubmissionStatus,
} from '@school/shared';
import { listAcademicYears } from '../../lib/repos/academic';
import {
  approveSheet,
  paginateSubmissions,
  rejectSheet,
  returnSheet,
} from '../../lib/repos/marks';
import { QueryError, type ListResponse } from '../../lib/query';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';
import { useAcademicYearOptions } from '../../hooks/useAcademicYears';
import { cn, formatRelative, pluralise } from '../../lib/utils';
import { SubmissionStatus as StatusBadge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { SearchInput, SegmentedControl, Select, Textarea } from '../../components/ui/Field';
import { IconCheck } from '../../components/ui/icons';
import {
  IdentityCell,
  Pagination,
  Table,
  TableEmpty,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../../components/ui/Table';
import { Alert, ErrorState, TableSkeleton } from '../../components/ui/States';
import { DataToolbar, PageHeader } from '../../components/ui/Layout';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';

/** Sheets per page. Paging is done in Postgres, so this is just the page size. */
const PAGE_SIZE = 20;

/** Every status a reviewer can act on right now — the default view. */
const OPEN_STATUSES = 'SUBMITTED,UNDER_REVIEW';

/**
 * Reviewer queue.
 *
 * This is a quality-control screen, so it is built to answer three questions
 * before a reviewer clicks anything:
 *
 *   - **Who submitted this, and when?**
 *   - **How complete is it, and does anything look wrong?** — an incomplete
 *     sheet (fewer marks than students) is the single most common reason a sheet
 *     should be returned, so it is surfaced as a warning rather than buried.
 *   - **What will each decision do?**
 *
 * The three decisions have genuinely different consequences, so each gets its
 * own dialog spelling out what happens next. Returning or rejecting requires an
 * explanation, enforced in the UI as well as on the server, because that message
 * is the only guidance the teacher gets.
 */
export default function ReviewQueuePage() {
  const queryClient = useQueryClient();
  const { success, error: errorToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<SubmissionStatus | 'open' | 'all'>('open');
  const [decisionFor, setDecisionFor] = useState<MarkSubmission | null>(null);
  const [decision, setDecision] = useState<'APPROVED' | 'RETURNED' | 'REJECTED'>('APPROVED');
  const [comments, setComments] = useState('');

  /**
   * Paging happens in Postgres.
   *
   * This used to fetch the caller's entire queue and slice it here under a 200-row
   * cap, which meant sheets past the cap were not merely on another page — they
   * were absent, and the total shown was wrong.
   */
  const fetcher = useCallback(
    async (params: ListParams): Promise<ListResponse<MarkSubmission>> =>
      paginateSubmissions(
        {
          academicYearId: (params.academicYearId as string) || undefined,
          status: (params.status as string) || undefined,
          search: (params.search as string) || undefined,
        },
        Number(params.page) || 1,
        Number(params.pageSize) || PAGE_SIZE,
      ),
    [],
  );

  const {
    items,
    total,
    page,
    setPage,
    pageSize,
    setPageSize,
    searchInput,
    setSearchInput,
    filters,
    setFilter,
    isLoading,
    isPlaceholderData,
    error,
    refetch,
  } = useListQuery<MarkSubmission>({
    key: ['submissions', 'review-queue'],
    fetcher,
    initialFilters: { status: OPEN_STATUSES },
  });

  // The queue has always shown twenty at a time.
  useEffect(() => {
    setPageSize(PAGE_SIZE);
  }, [setPageSize]);

  const { academicYears: years } = useAcademicYearOptions({ includeArchived: false });

  const academicYearId = (filters.academicYearId as string) ?? '';

  /**
   * Every decision goes through `apply_submission_transition`, which refuses
   * rather than resolving with a failure, so an `ok: false` can never leave a
   * reviewer believing they approved something that was refused.
   */
  const decide = useMutation({
    mutationFn: async () => {
      const target = decisionFor;
      if (!target) {
        throw new QueryError('NO_SUBMISSION', 'That mark sheet is no longer available.');
      }
      const note = comments.trim() || undefined;

      if (decision === 'APPROVED') return approveSheet(target.id, target.version, note);
      if (decision === 'RETURNED') return returnSheet(target.id, target.version, note);
      return rejectSheet(target.id, target.version, note);
    },
    onSuccess: () => {
      const target = decisionFor;
      setDecisionFor(null);
      setComments('');
      success(
        decision === 'APPROVED'
          ? `Approved ${target?.subjectName ?? 'mark sheet'}`
          : decision === 'RETURNED'
            ? 'Returned to the teacher'
            : 'Mark sheet rejected',
        decision === 'APPROVED'
          ? 'The teacher can no longer edit these marks.'
          : `${target?.teacherName ?? 'The teacher'} has been notified with your comments.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (caught) => {
      errorToast(
        caught instanceof QueryError ? caught.userMessage : 'Could not record your decision.',
        caught instanceof QueryError && caught.isConflict
          ? 'Someone else changed this sheet. Reload the queue and try again.'
          : undefined,
      );
    },
  });

  const openDecision = (submission: MarkSubmission, next: typeof decision) => {
    setDecisionFor(submission);
    setDecision(next);
    setComments('');
  };

  const filtering = statusFilter !== 'open' || Boolean(searchInput) || Boolean(academicYearId);

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Check submitted mark sheets, then approve them or send them back with an explanation."
      />

      <div className="card-surface mb-4 overflow-hidden">
        <DataToolbar>
          {/*
            A segmented control rather than a select: "needs action" is the
            default and the most common filter, and hiding it behind a dropdown
            would be the wrong trade.
          */}
          <SegmentedControl
            label="Filter by status"
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter(value);
              // "Open" is the reviewer's default view: everything a person can
              // actually act on, which is what they came to this page for.
              setFilter(
                'status',
                value === 'all' ? undefined : value === 'open' ? OPEN_STATUSES : value,
              );
            }}
            options={[
              { value: 'open', label: 'Needs action' },
              { value: 'all', label: 'All' },
              { value: SUBMISSION_STATUS.APPROVED, label: 'Approved' },
              { value: SUBMISSION_STATUS.LOCKED, label: 'Locked' },
              { value: SUBMISSION_STATUS.RETURNED, label: 'Returned' },
              { value: SUBMISSION_STATUS.REJECTED, label: 'Rejected' },
            ]}
          />

          <div className="h-5 w-px bg-line" aria-hidden="true" />

          <Select
            label="Academic year"
            hideLabel
            controlSize="sm"
            value={academicYearId}
            onChange={(event) => setFilter('academicYearId', event.target.value)}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            placeholder="All years"
            wrapperClassName="w-44"
          />

          <SearchInput
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onClear={() => setSearchInput('')}
            placeholder="Teacher, subject or exam"
            label="Search the queue"
            wrapperClassName="w-56"
          />
        </DataToolbar>

        {isLoading ? (
          <TableSkeleton rows={8} columns={7} />
        ) : error instanceof QueryError ? (
          <ErrorState
            title="We could not load the queue"
            message={error.userMessage}
            onRetry={() => void refetch()}
          />
        ) : items.length === 0 ? (
          <TableEmpty
            colSpan={7}
            filtered={filtering}
            title="Nothing to review"
            description="When a teacher submits a mark sheet it appears here for approval."
            action={
              !filtering ? (
                <p className="text-xs text-ink-subtle">
                  Sheets waiting for a teacher to submit do not appear here.
                </p>
              ) : undefined
            }
          />
        ) : (
          <div className={cn(isPlaceholderData && 'opacity-60 transition-opacity')}>
            <Table caption="Mark sheets awaiting review" stickyHeader>
              <THead>
                <tr>
                  <TH>Mark sheet</TH>
                  <TH>Submitted by</TH>
                  <TH numeric>Entered</TH>
                  <TH numeric>Average</TH>
                  <TH>Submitted</TH>
                  <TH>Status</TH>
                  <TH className="text-right">
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {items.map((submission) => {
                  const actionable =
                    submission.status === SUBMISSION_STATUS.SUBMITTED ||
                    submission.status === SUBMISSION_STATUS.UNDER_REVIEW;
                  const incomplete =
                    submission.enteredCount < submission.totalStudents &&
                    submission.status !== SUBMISSION_STATUS.LOCKED;

                  return (
                    <TR key={submission.id}>
                      <TD>
                        <IdentityCell
                          primary={`${submission.subjectName} · ${submission.examName}`}
                          secondary={
                            <>
                              Class {submission.className}-{submission.sectionName}
                              {submission.subjectCode ? ` · ${submission.subjectCode}` : ''}
                            </>
                          }
                          trailing={
                            /*
                             An incomplete sheet is the most common reason a
                             sheet should go back, so it is flagged in the row
                             rather than left for the reviewer to spot.
                             */
                            incomplete && (
                              <span
                                title={`${submission.totalStudents - submission.enteredCount} students have no mark yet`}
                                className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-2xs font-medium text-warning-strong"
                              >
                                {submission.totalStudents - submission.enteredCount} missing
                              </span>
                            )
                          }
                        />
                      </TD>

                      <TD>
                        <span className="block truncate text-ink">{submission.teacherName}</span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {submission.teacherEmail}
                        </span>
                      </TD>

                      <TD numeric className="whitespace-nowrap">
                        <span className="text-ink">{submission.enteredCount}</span>
                        <span className="text-ink-faint">/{submission.totalStudents}</span>
                      </TD>

                      <TD numeric>
                        {submission.averageMarks === null || submission.averageMarks === undefined
                          ? '—'
                          : submission.averageMarks.toFixed(1)}
                      </TD>

                      <TD className="tabular whitespace-nowrap text-ink-muted">
                        {submission.submittedAt ? formatRelative(submission.submittedAt) : '—'}
                      </TD>

                      <TD>
                        <StatusBadge status={submission.status} />
                      </TD>

                      <TD>
                        <div className="flex justify-end gap-1.5">
                          <LinkButton
                            to={`/app/review/${submission.id}`}
                            size="sm"
                            variant="ghost"
                          >
                            Inspect
                          </LinkButton>
                          {actionable && (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                icon={<IconCheck size={13} />}
                                onClick={() => openDecision(submission, 'APPROVED')}
                              >
                                Approve
                              </Button>
                              <Button size="sm" onClick={() => openDecision(submission, 'RETURNED')}>
                                Return
                              </Button>
                            </>
                          )}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>

            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              extra={<span className="text-xs text-ink-subtle">{pluralise(total, 'sheet')}</span>}
            />
          </div>
        )}
      </div>

      {decisionFor && (
        <DecisionDialog
          submission={decisionFor}
          decision={decision}
          comments={comments}
          onCommentsChange={setComments}
          busy={decide.isPending}
          onClose={() => setDecisionFor(null)}
          onConfirm={() => decide.mutate()}
        />
      )}
    </>
  );
}

/* ==========================================================================
   Decision dialog
   ========================================================================== */

function DecisionDialog({
  submission,
  decision,
  comments,
  onCommentsChange,
  busy,
  onClose,
  onConfirm,
}: {
  submission: MarkSubmission;
  decision: 'APPROVED' | 'RETURNED' | 'REJECTED';
  comments: string;
  onCommentsChange: (value: string) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const commentsRequired = decision !== 'APPROVED';
  const canConfirm = !commentsRequired || comments.trim().length >= 3;

  const copy = {
    APPROVED: {
      title: 'Approve these marks',
      confirm: 'Approve marks',
      tone: 'success' as const,
      consequence:
        'Approving freezes these marks against teacher edits. You can still lock the sheet, or return it if a problem is found later.',
    },
    RETURNED: {
      title: 'Return for correction',
      confirm: 'Return to teacher',
      tone: 'warning' as const,
      consequence:
        'The teacher will be able to edit these marks again. Explain exactly what needs correcting — this message is the only guidance they get.',
    },
    REJECTED: {
      title: 'Reject these marks',
      confirm: 'Reject marks',
      tone: 'danger' as const,
      consequence:
        'These marks will be discarded and will not be published. The teacher can start a fresh sheet, but this submission is finished.',
    },
  }[decision];

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      description={`${submission.subjectName} · Class ${submission.className}-${submission.sectionName} · ${submission.examName}`}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={decision === 'REJECTED' ? 'danger' : 'primary'}
            loading={busy}
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* A quick read of what is being decided, before the consequence. */}
        <dl className="grid grid-cols-3 gap-3 rounded border border-line bg-surface-muted px-3 py-2.5">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-ink-subtle">Marks entered</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">
              {submission.enteredCount} of {submission.totalStudents}
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-ink-subtle">Average</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">
              {submission.averageMarks?.toFixed(1) ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-ink-subtle">Current status</dt>
            <dd className="mt-0.5">
              <StatusBadge status={submission.status} size="xs" showHelp={false} />
            </dd>
          </div>
        </dl>

        <Alert tone={copy.tone}>{copy.consequence}</Alert>

        <Textarea
          label={commentsRequired ? 'What needs correcting (required)' : 'Reviewer comment (optional)'}
          value={comments}
          onChange={(event) => onCommentsChange(event.target.value)}
          required={commentsRequired}
          maxLength={1000}
          rows={4}
          placeholder={
            decision === 'RETURNED'
              ? 'e.g. Three students are missing marks. Please check roll numbers 5, 12 and 18.'
              : decision === 'REJECTED'
                ? 'e.g. This exam was sat under the wrong syllabus and cannot be published.'
                : 'Add a note for the record…'
          }
          hint={commentsRequired ? 'At least 3 characters. The teacher sees this message.' : undefined}
        />
      </div>
    </Modal>
  );
}
