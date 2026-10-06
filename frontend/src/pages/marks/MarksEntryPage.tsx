import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  MARK_STATUS,
  PERMISSIONS,
  type MarkEntryRow,
  type MarkSubmission,
  type SubmissionStatus,
} from '@school/shared';
import { listAssignments, listClasses, listExams, listSubjects } from '../../lib/repos/academic';
import { getMarksGrid, getSubmission, listSubjectsForSheet, setSheetMax, submitSheet } from '../../lib/repos/marks';
import { QueryError } from '../../lib/query';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { SUBMISSION_STATUS_STYLES } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Select, Textarea } from '../../components/ui/Field';
import { Card } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { MarksGrid } from '../../components/marks/MarksGrid';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { IconCheck } from '../../components/ui/icons';

/**
 * Marks entry.
 *
 * The four selectors (year → class/section → subject → exam) are deliberately
 * cascading and derived from the teacher's *assignments*, so a teacher can only
 * reach a sheet they are entitled to. The server re-checks all of it regardless.
 */
export default function MarksEntryPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { success, error: errorToast } = useToast();
  const [searchParams] = useSearchParams();

  const [academicYearId, setAcademicYearId] = useState<string>('');
  const [sectionId, setSectionId] = useState<string>('');
  const [subjectId, setSubjectId] = useState<string>('');
  const [examId, setExamId] = useState<string>('');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitComments, setSubmitComments] = useState('');
  const [initialised, setInitialised] = useState(false);

  const canSubmit = can(user, PERMISSIONS.MARKS_SUBMIT);

  /* ---------------------------------------------------------------------- */
  /* Reference data                                                          */
  /* ---------------------------------------------------------------------- */

  const { data: yearsData, isLoading: yearsLoading } = useAcademicYears();

  // The teacher's own assignments drive the section selector and, through them,
  // which class the sheet belongs to.
  const { data: assignments } = useQuery({
    queryKey: ['assignments', 'mine', academicYearId],
    queryFn: () =>
      listAssignments({ academicYearId, teacherId: user?.id ?? undefined }),
    enabled: Boolean(academicYearId && user?.id),
  });

  // A class teacher drives their whole section, not a fixed list of subject rows.
  const { data: programs } = useQuery({
    queryKey: ['programs', 'teacher', user?.id, academicYearId],
    queryFn: () => listClasses(academicYearId),
    enabled: Boolean(academicYearId && user?.id),
  });

  const myClassSections = useMemo(() => {
    const sections: Array<{ sectionId: string; classId: string; label: string }> = [];
    for (const section of programs?.sections ?? []) {
      if (section.classTeacherId !== user?.id) continue;
      const classRecord = (programs?.classes ?? []).find((row) => row.id === section.classId);
      sections.push({
        sectionId: section.id,
        classId: section.classId,
        label: `Class ${classRecord?.name ?? '?'} · Section ${section.name}`,
      });
    }
    return sections;
  }, [programs, user?.id]);

  const sectionOptions = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const assignment of assignments ?? []) {
      const key = `${assignment.classId}:${assignment.sectionId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        id: assignment.sectionId,
        label: `Class ${assignment.className ?? '?'} · Section ${assignment.sectionName ?? '?'}`,
      });
    }
    for (const section of myClassSections) {
      const key = `${section.classId}:${section.sectionId}`;
      if (!seen.has(key)) seen.set(key, { id: section.sectionId, label: section.label });
    }
    return [...seen.values()];
  }, [assignments, myClassSections]);

  /**
   * `getMarksGrid` takes the class explicitly, and the submission needs it for
   * its unique key, so it is resolved from the assignment or the class-teacher
   * section that supplied the section rather than being guessed.
   */
  const classId = useMemo(() => {
    const fromAssignment = (assignments ?? []).find(
      (assignment) => assignment.sectionId === sectionId,
    );
    if (fromAssignment) return fromAssignment.classId;
    return myClassSections.find((section) => section.sectionId === sectionId)?.classId ?? '';
  }, [assignments, myClassSections, sectionId]);

  const { data: subjects = [] } = useQuery({
    queryKey: ['marks', 'subjects-for-sheet', sectionId, academicYearId],
    queryFn: () => listSubjectsForSheet(sectionId, academicYearId),
    enabled: Boolean(sectionId && academicYearId),
  });

  const isMyClassSection = myClassSections.some((section) => section.sectionId === sectionId);

  const { data: allSubjects = [] } = useQuery({
    queryKey: ['subjects', 'active'],
    queryFn: () => listSubjects(),
    enabled: Boolean(sectionId && isMyClassSection),
  });

  // Assignments drive the teacher's subject list, except for sections they own:
  // the class teacher enters marks for *every* subject in that section.
  const subjectOptions = useMemo(() => {
    if (isMyClassSection) {
      return allSubjects.map((subject) => ({
        value: subject.id,
        label: `${subject.code} · ${subject.name}`,
      }));
    }
    const mine = new Set(
      (assignments ?? [])
        .filter((assignment) => assignment.sectionId === sectionId)
        .map((assignment) => assignment.subjectId),
    );
    return subjects
      .filter((subject) => mine.has(subject.id))
      .map((subject) => ({ value: subject.id, label: `${subject.code} · ${subject.name}` }));
  }, [subjects, allSubjects, assignments, sectionId, isMyClassSection]);

  const { data: exams = [] } = useQuery({
    queryKey: ['exams', academicYearId],
    queryFn: () => listExams(academicYearId),
    enabled: Boolean(academicYearId),
  });

  /* ---------------------------------------------------------------------- */
  /* Deep link                                                              */
  /* ---------------------------------------------------------------------- */

  const linkedSubmissionId = searchParams.get('submissionId');

  const { data: linkedSubmission } = useQuery({
    queryKey: ['submissions', linkedSubmissionId],
    queryFn: () => getSubmission(linkedSubmissionId as string),
    enabled: Boolean(linkedSubmissionId),
  });

  // A deep link like /app/marks?submissionId=… selects that sheet. Applied after
  // the reference data has loaded, so the cascading defaults cannot overwrite it.
  useEffect(() => {
    if (!linkedSubmission) return;
    setAcademicYearId(linkedSubmission.academicYearId);
    setSectionId(linkedSubmission.sectionId);
    setSubjectId(linkedSubmission.subjectId);
    setExamId(linkedSubmission.examId);
  }, [linkedSubmission]);

  /* ---------------------------------------------------------------------- */
  /* Default selection                                                       */
  /* ---------------------------------------------------------------------- */

  // Pick the current academic year on first load, then the first assignment.
  useEffect(() => {
    if (initialised || !yearsData) return;
    setInitialised(true);
    // A deep-linked sheet chooses its own year.
    if (linkedSubmissionId) return;
    const initial = yearsData.current ?? yearsData.academicYears[0];
    if (initial) setAcademicYearId(initial.id);
  }, [yearsData, initialised, linkedSubmissionId]);

  useEffect(() => {
    if (!sectionOptions.length) return;
    const exists = sectionOptions.some((option) => option.id === sectionId);
    if (!exists) setSectionId(sectionOptions[0]?.id ?? '');
  }, [sectionOptions, sectionId]);

  useEffect(() => {
    if (!subjectOptions.length) {
      setSubjectId('');
      return;
    }
    const exists = subjectOptions.some((option) => option.value === subjectId);
    if (!exists) setSubjectId(subjectOptions[0]?.value ?? '');
  }, [subjectOptions, subjectId]);

  useEffect(() => {
    if (!exams.length) {
      setExamId('');
      return;
    }
    const exists = exams.some((exam) => exam.id === examId);
    if (!exists) setExamId(exams[0]?.id ?? '');
  }, [exams, examId]);

  /* ---------------------------------------------------------------------- */
  /* Grid                                                                    */
  /* ---------------------------------------------------------------------- */

  const selectionComplete = Boolean(academicYearId && classId && sectionId && subjectId && examId);

  const { data: grid, isLoading, error, refetch } = useQuery({
    queryKey: ['marks', 'grid', academicYearId, sectionId, subjectId, examId],
    queryFn: () =>
      getMarksGrid({ academicYearId, classId, sectionId, subjectId, examId }),
    enabled: selectionComplete,
  });

  /** Entered / total / average, counted from the rows on screen. */
  const stats = useMemo(() => summariseSheet(grid?.rows), [grid?.rows]);

  const submit = useMutation({
    mutationFn: async () => {
      const sheet = grid?.submission;
      // Marks always arrive through a save or an OCR confirm, and both find-or-
      // create the sheet first, so this is unreachable in practice — but
      // `submitSheet` needs an id and a silent no-op would be worse than a message.
      if (!sheet) {
        throw new QueryError(
          'NO_SUBMISSION',
          'Save at least one mark before submitting this sheet for review.',
        );
      }
      // An empty note is sent as "no comment": the transition coalesces its
      // argument, so an empty string would blank the reviewer's last comment.
      return submitSheet(sheet.id, sheet.version, submitComments.trim() || undefined);
    },
    onSuccess: () => {
      setSubmitOpen(false);
      setSubmitComments('');
      success('Marks submitted for review', 'Your reviewer has been notified.');
      void queryClient.invalidateQueries({ queryKey: ['marks'] });
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (caught) => {
      errorToast(
        caught instanceof QueryError ? caught.userMessage : 'Could not submit these marks.',
      );
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (yearsLoading) return <LoadingState label="Loading academic years…" />;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Choose a class and subject, then enter marks. Changes save automatically.
          </h1>
        </div>

        {grid?.submission && <SubmissionStatusBadge submission={grid.submission} />}
      </header>

      {/* Selectors */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Academic year"
            value={academicYearId}
            onChange={(event) => {
              setAcademicYearId(event.target.value);
              setSectionId('');
              setSubjectId('');
            }}
            options={(yearsData?.academicYears ?? []).map((year) => ({
              value: year.id,
              label: `${year.name}${year.isCurrent ? ' (current)' : ''}`,
            }))}
            placeholder="Select a year"
          />

          <Select
            label="Class & section"
            value={sectionId}
            onChange={(event) => {
              setSectionId(event.target.value);
              setSubjectId('');
            }}
            options={sectionOptions.map((option) => ({ value: option.id, label: option.label }))}
            placeholder={sectionOptions.length ? 'Select a section' : 'No class or subject assignments'}
            disabled={sectionOptions.length === 0}
            hint={sectionOptions.length === 0 ? 'You have no class or subject assignments for this year.' : undefined}
          />

          <Select
            label="Subject"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            options={subjectOptions}
            placeholder={subjectOptions.length ? 'Select a subject' : 'No subjects'}
            disabled={subjectOptions.length === 0}
          />

          <Select
            label="Exam"
            value={examId}
            onChange={(event) => setExamId(event.target.value)}
            options={exams.map((exam) => ({
              value: exam.id,
              label: `${exam.name} (max ${exam.maxMarks})`,
            }))}
            placeholder="Select an exam"
            disabled={!exams.length}
          />
        </div>
      </Card>

      {/* Grid */}
      {!selectionComplete && (
        <EmptyState
          title="Choose a class, subject and exam"
          description="Your selections are limited to the classes and subjects you are assigned."
          icon="📚"
        />
      )}

      {selectionComplete && isLoading && <LoadingState label="Loading the mark sheet…" />}

      {selectionComplete && error instanceof QueryError && (
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
      )}

      {selectionComplete && error && !(error instanceof QueryError) && (
        <ErrorState message="Could not load this mark sheet." onRetry={() => void refetch()} />
      )}

      {selectionComplete && grid && (
        <>
          {grid.submission && !grid.editable && <LockedNotice submission={grid.submission} />}

          {grid.submission?.status === 'RETURNED' && grid.submission.reviewComments && (
            <Alert tone="warning" title="Returned for correction">
              {grid.submission.reviewComments}
            </Alert>
          )}

          <SheetMaxEditor
            academicYearId={academicYearId}
            classId={classId}
            sectionId={sectionId}
            subjectId={subjectId}
            examId={examId}
            currentMax={grid.maxMarks}
            hasOverride={grid.hasSheetOverride}
            canEdit={Boolean(grid.editable)}
          />

          <MarksGrid context={grid} editable={grid.editable} />

          {canSubmit && grid.editable && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              <p className="mr-auto text-sm text-ink-muted">
                {stats.entered === 0
                  ? 'Enter at least one mark before submitting.'
                  : `${stats.entered} of ${stats.total} students have marks.`}
              </p>
              <Button
                variant="primary"
                icon={<IconCheck size={16} />}
                onClick={() => setSubmitOpen(true)}
                disabled={stats.entered === 0}
              >
                Submit for review
              </Button>
            </div>
          )}
        </>
      )}

      {/* Submit confirmation */}
      <Modal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        title="Submit marks for review"
        description="After submitting, you cannot edit these marks until a reviewer approves them or returns the sheet."
        busy={submit.isPending}
        footer={
          <>
            <Button onClick={() => setSubmitOpen(false)} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={submit.isPending}
              onClick={() => submit.mutate()}
            >
              Submit for review
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-surface-muted p-3 text-sm">
            <div>
              <dt className="text-xs text-ink-subtle">Students with marks</dt>
              <dd className="tabular font-medium text-ink">{stats.entered}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-subtle">Average</dt>
              <dd className="tabular font-medium text-ink">
                {stats.average ?? '—'}
              </dd>
            </div>
          </dl>

          <Textarea
            label="Note for the reviewer (optional)"
            value={submitComments}
            onChange={(event) => setSubmitComments(event.target.value)}
            placeholder="Anything the reviewer should know about this sheet…"
            maxLength={1000}
          />
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "Out of" editor for the current sheet.
 *
 * The exam's max is the school-wide default, but classes 11 and 12 — and plenty
 * of subjects in other years — are assessed out of a different total. The
 * override is keyed to this exact sheet (year, section, subject, exam), so
 * Physics in Grade 12 can be out of 70 while English is out of 100, on the same
 * exam.
 */
function SheetMaxEditor({
  academicYearId,
  classId,
  sectionId,
  subjectId,
  examId,
  currentMax,
  hasOverride,
  canEdit,
}: {
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
  currentMax: number;
  hasOverride?: boolean;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { success, error: errorToast } = useToast();
  const [draft, setDraft] = useState(String(currentMax));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(String(currentMax));
  }, [currentMax, examId, subjectId]);

  const apply = async (value: string) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      errorToast('The maximum must be a number greater than zero.');
      setDraft(String(currentMax));
      return;
    }
    setBusy(true);
    try {
      await setSheetMax({ academicYearId, classId, sectionId, subjectId, examId }, numeric);
      success(`Out of ${numeric}`, 'This sheet now uses that maximum.');
      void queryClient.invalidateQueries({ queryKey: ['marks', 'grid'] });
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not set the maximum.');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await setSheetMax({ academicYearId, classId, sectionId, subjectId, examId }, null);
      success('Reset to the exam default');
      void queryClient.invalidateQueries({ queryKey: ['marks', 'grid'] });
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not reset the maximum.');
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-muted">
        Out of <span className="tabular font-semibold text-ink">{currentMax}</span>
        {hasOverride && <span className="text-ink-subtle"> (sheet-specific)</span>}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="sheet-max" className="font-medium text-ink">
        Out of
      </label>
      <input
        id="sheet-max"
        type="number"
        min={1}
        step="any"
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== '' && Number(draft) !== currentMax) void apply(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void apply(draft);
          }
        }}
        className="tabular h-9 w-24 rounded border border-line bg-surface px-2 text-ink shadow-xs focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      {hasOverride ? (
        <>
          <span className="text-xs text-ink-subtle">custom for this sheet</span>
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={busy}>
            Reset to exam default
          </Button>
        </>
      ) : (
        <span className="text-xs text-ink-subtle">the exam default — change it for this sheet only</span>
      )}
    </div>
  );
}

/**
 * Sheet counters for the submit bar.
 *
 * Counted from the rows rather than read from the submission, because a teacher
 * is looking at this screen while typing: the stored `entered_count` only moves
 * once the debounced autosave has flushed.
 */
function summariseSheet(rows: MarkEntryRow[] | undefined): {
  total: number;
  entered: number;
  average: number | null;
} {
  const all = rows ?? [];
  const scored = all
    .filter((row) => row.status === MARK_STATUS.PRESENT && row.marksObtained !== null)
    .map((row) => Number(row.marksObtained));

  if (scored.length === 0) return { total: all.length, entered: 0, average: null };

  const total = scored.reduce((sum, value) => sum + value, 0);
  return {
    total: all.length,
    entered: scored.length,
    average: Math.round((total / scored.length) * 100) / 100,
  };
}

function SubmissionStatusBadge({ submission }: { submission: MarkSubmission }) {
  const style = SUBMISSION_STATUS_STYLES[submission.status as SubmissionStatus];
  return (
    <div className="flex items-center gap-2">
      <Badge className={style.className} dotClassName={style.dotClassName}>
        {style.label}
      </Badge>
      <span className="tabular text-xs text-ink-subtle">
        {submission.enteredCount}/{submission.totalStudents} entered
      </span>
    </div>
  );
}

function LockedNotice({ submission }: { submission: MarkSubmission }) {
  return (
    <Alert tone="info" title={`These marks are ${submission.status.toLowerCase()}`}>
      {submission.status === 'LOCKED'
        ? 'Locked marks are a permanent record. If a correction is genuinely needed, ask an administrator — every correction requires a written reason and is recorded in the audit log.'
        : 'These marks have already been submitted. A reviewer will approve them or return the sheet with comments.'}
      {submission.reviewComments && (
        <p className="mt-2 rounded bg-surface/60 p-2 text-sm">
          <strong>Reviewer comment:</strong> {submission.reviewComments}
        </p>
      )}
    </Alert>
  );
}
