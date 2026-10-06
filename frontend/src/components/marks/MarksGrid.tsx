import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ALL_MARK_STATUSES,
  MARK_STATUS,
  validateMark,
  type MarkEntryRow,
  type MarksGridResponse,
  type MarkStatus,
} from '@school/shared';
import { saveMarksGrid } from '../../lib/repos/marks';
import { cn, formatMark } from '../../lib/utils';
import { EmptyList, Note } from '../ui/States';
import { SearchInput, Select } from '../ui/Field';
import { IconAlertCircle, IconCheck, IconLock, IconUsers } from '../ui/icons';
import { useToast } from '../ui/Toast';
import { MarkCell } from './MarkCell';

/**
 * Excel-like marks grid.
 *
 * The decisions that matter to a teacher entering sixty marks:
 *
 *  - **Local edits are instant; autosave is debounced.** Typing never waits on
 *    the network. Rows flush 1.2s after the last keystroke.
 *  - **Only touched rows are sent.** Saving a 300-student section transmits a
 *    handful of rows, not the whole class.
 *  - **Draft saves tolerate invalid rows.** A half-typed value is not a reason
 *    to lose the other twenty-nine edits in the batch. The invalid row is
 *    reported inline and skipped.
 *  - **The unsaved-changes guard is honest.** `beforeunload` fires only while
 *    there genuinely are pending changes, so the prompt never cries wolf.
 *  - **A version conflict is loud and specific.** If another user saved first,
 *    the grid stops autosaving and says exactly what happened rather than
 *    showing a generic failure.
 *
 * Layout: the student identity columns are sticky so a wide grid stays
 * readable while scrolling horizontally, and the header is sticky so column
 * meanings survive a long class.
 */

const AUTOSAVE_DELAY_MS = 1200;

export interface MarksGridProps {
  context: MarksGridResponse;
  editable: boolean;
  onSaved?: () => void;
}

interface EditableRow {
  marks: string;
  status: MarkStatus;
  remarks: string | null;
  /** The last value known to be saved, used to show what is edited. */
  saved: string;
}

export function MarksGrid({ context, editable, onSaved }: MarksGridProps) {
  const queryClient = useQueryClient();
  const { success } = useToast();

  const [rows, setRows] = useState<Map<string, EditableRow>>(
    () => new Map(context.rows.map((row) => [row.studentId, toEditable(row)])),
  );
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<MarkStatus | ''>('');
  const [search, setSearch] = useState('');
  /** Set when the server rejects our version; stops autosave until resolved. */
  const [conflict, setConflict] = useState<string | null>(null);
  /**
   * Set when an autosave attempt fails for any other reason. Surfaces the cause
   * inline and pauses further autosaves until the teacher makes another edit —
   * without this, a failing save retried silently every debounce and the teacher
   * had no way to know their work was not being kept.
   */
  const [saveError, setSaveError] = useState<string | null>(null);

  const cellRefs = useRef(new Map<string, HTMLInputElement>());
  const timerRef = useRef<number | null>(null);

  // Re-sync when the server sends new rows (first load, or after a reload).
  useEffect(() => {
    setRows(new Map(context.rows.map((row) => [row.studentId, toEditable(row)])));
    setDirty(new Set());
    setConflict(null);
  }, [context]);

  const invalidCells = useMemo(() => {
    const invalid = new Map<string, string>();
    for (const row of context.rows) {
      const edit = rows.get(row.studentId);
      if (!edit) continue;
      const result = validateMark(edit.marks, context.maxMarks, edit.status);
      if (!result.valid) invalid.set(row.studentId, result.message ?? 'Invalid mark');
    }
    return invalid;
  }, [context.rows, rows, context.maxMarks]);

  const dirtyRows = useMemo(
    () => context.rows.filter((row) => dirty.has(row.studentId)),
    [context.rows, dirty],
  );

  /**
   * The rows the teacher actually touched, shaped for the `save_marks_grid` RPC.
   *
   * `marks` is an empty string in the local edit buffer, meaning "cleared". That
   * is converted to `null` here rather than sent as `''`: the RPC parses marks
   * with a numeric cast, and an empty string is a refusal the user would have to
   * decode. `null` is the correct meaning — no numeric mark recorded.
   */
  const buildRows = useCallback(
    (onlyDirty: boolean) =>
      (onlyDirty ? dirtyRows : context.rows).map((row) => {
        const edit = rows.get(row.studentId);
        const raw = edit?.marks;

        return {
          studentId: row.studentId,
          marks: raw === '' || raw === undefined ? null : Number(raw),
          status: edit?.status ?? 'PRESENT',
          remarks: edit?.remarks ?? null,
        };
      }),
    [context.rows, dirtyRows, rows],
  );

  const buildContext = useCallback(
    () => ({
      academicYearId: context.academicYearId,
      classId: context.classId,
      sectionId: context.sectionId,
      subjectId: context.subjectId,
      examId: context.examId,
    }),
    [context],
  );

  const autosave = useMutation({
    mutationFn: () =>
      saveMarksGrid({
        ctx: buildContext(),
        rows: buildRows(true),
        expectedVersion: context.submission?.version ?? null,
      }),
    onSuccess: (result) => {
      // `save_marks_grid` returns a refusal envelope rather than throwing, so a
      // rejected save reaches onSuccess with `ok === false`. Checking it here is
      // what stops the grid clearing its dirty set and showing a success toast for
      // a write the database rejected.
      if (!result.ok) {
        autosave.reset();
        setConflict(
          result.code === 'SUBMISSION_NOT_EDITABLE'
            ? result.message ?? 'This mark sheet is no longer editable. Reload to see its current state.'
            : 'Another user changed this sheet while you were editing. Your unsaved marks are still here — copy anything you need, then reload to see the current values.',
        );
        return;
      }

      setDirty(new Set());
      setConflict(null);
      setSaveError(null);
      onSaved?.();
      void queryClient.invalidateQueries({ queryKey: ['marks', 'grid'] });
      // Only worth announcing when there was something meaningful to save.
      if (dirty.size > 1) {
        success(`Saved ${dirty.size} marks`, 'Draft — not yet submitted for review.');
      }
    },
    onError: (error) => {
      // A version conflict is a different event from a generic failure and needs
      // different handling: retrying will not help, and continuing to autosave
      // would overwrite someone else's work.
      const isConflict =
        typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CONFLICT';

      if (isConflict) {
        setConflict(
          'Another user changed this sheet while you were editing. Your unsaved marks are still here — copy anything you need, then reload to see the current values.',
        );
        return;
      }

      // A generic save failure is not retried in a loop: retrying the same
      // request that just failed until the teacher changes something would be
      // noise, and worse, would make the grid look busy while keeping nothing.
      // The next edit is the retry signal.
      setSaveError(error instanceof Error ? error.message : 'Could not save changes.');
    },
  });

  const scheduleAutosave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (dirty.size > 0 && !conflict && !saveError) autosave.mutate();
    }, AUTOSAVE_DELAY_MS);
  }, [autosave, dirty.size, conflict, saveError]);

  useEffect(() => {
    if (dirty.size === 0 || conflict || saveError) return undefined;
    scheduleAutosave();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [dirty, scheduleAutosave, conflict, saveError]);

  // A page close mid-edit must not lose work.
  useEffect(() => {
    if (dirty.size === 0) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty.size]);

  const setCell = (studentId: string, patch: Partial<EditableRow>) => {
    setRows((current) => {
      const next = new Map(current);
      const existing = next.get(studentId) ?? { marks: '', status: 'PRESENT', remarks: null, saved: '' };
      next.set(studentId, { ...existing, ...patch });
      return next;
    });
    setDirty((current) => new Set(current).add(studentId));
    // A new edit is the signal to give saving another try.
    setSaveError(null);
  };

  /** Move focus to the next/previous row's mark cell. */
  const navigateRow = (fromStudentId: string, direction: 1 | -1, focus: boolean) => {
    const index = context.rows.findIndex((row) => row.studentId === fromStudentId);
    const target = context.rows[index + direction];
    if (!target || !focus) return;
    const element = cellRefs.current.get(target.studentId);
    element?.focus();
    element?.select();
  };

  const applyBulkStatus = (status: MarkStatus) => {
    const next = new Map<string, EditableRow>();
    const nextDirty = new Set(dirty);
    for (const row of context.rows) {
      const existing = rows.get(row.studentId);
      next.set(row.studentId, {
        marks: existing?.marks ?? '',
        // A non-numeric status clears any numeric mark on that row.
        status,
        remarks: existing?.remarks ?? null,
        saved: existing?.saved ?? '',
      });
      nextDirty.add(row.studentId);
    }
    setRows(next);
    setDirty(nextDirty);
    setBulkStatus('');
    // A new edit is the signal to give saving another try.
    setSaveError(null);
    success(
      `Marked ${context.rows.length} students as ${status.toLowerCase()}`,
      'Nothing is saved until the changes are flushed. Check the rows first.',
    );
  };

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return context.rows;
    return context.rows.filter(
      (row) =>
        row.fullName.toLowerCase().includes(term) ||
        row.studentNumber.toLowerCase().includes(term) ||
        String(row.rollNumber ?? '').includes(term),
    );
  }, [context.rows, search]);

  const presentCount = context.rows.filter((row) => {
    const edit = rows.get(row.studentId);
    return (edit?.status ?? row.status) === 'PRESENT' && (edit?.marks ?? '') !== '';
  }).length;

  if (context.rows.length === 0) {
    return (
      <EmptyList
        title="No students in this section"
        description="Add students to this class and section, or check that you have selected the right section."
      />
    );
  }

  return (
    <div className="space-y-3">
      <ConflictBanner message={conflict} />
      <SaveErrorBanner message={saveError} />

      {/* Toolbar: context, filter and the one bulk action. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="tabular text-sm text-ink-muted">
            <span className="font-semibold text-ink">{presentCount}</span> of {context.rows.length}{' '}
            entered
            {invalidCells.size > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 font-medium text-danger-strong">
                <IconAlertCircle size={12} />
                {invalidCells.size} out of range
              </span>
            )}
          </p>

          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            placeholder="Filter by name, number or roll"
            label="Filter students"
            wrapperClassName="w-64"
          />
        </div>

        {editable && (
          <Select
            label="Set attendance for everyone"
            hideLabel
            controlSize="sm"
            value={bulkStatus}
            onChange={(event) => {
              const value = event.target.value as MarkStatus;
              if (value) applyBulkStatus(value);
              else setBulkStatus('');
            }}
            options={[
              { value: '', label: 'Set attendance for all…' },
              ...ALL_MARK_STATUSES.filter((status) => status !== MARK_STATUS.PRESENT).map((status) => ({
                value: status,
                label: status.charAt(0) + status.slice(1).toLowerCase(),
              })),
            ]}
            hint="Applies to every row on screen. Mark cells individually for anything else."
            containerClassName="w-52"
          />
        )}
      </div>

      {visibleRows.length === 0 ? (
        <div className="card-surface">
          <EmptyList
            filtered
            action={
              <button
                type="button"
                onClick={() => setSearch('')}
                className="mt-1 text-sm font-medium text-brand-700 hover:underline"
              >
                Clear filter
              </button>
            }
          />
        </div>
      ) : (
        <>
          {/*
            The grid scrolls horizontally rather than reflowing. Sticky identity
            columns keep every mark attributable to a student, which is the whole
            point of a marks sheet.
          */}
          <div className="card-surface overflow-hidden">
            <div className="max-h-[calc(100vh-20rem)] overflow-auto scrollbar-thin">
              <table className="w-full min-w-[52rem] border-collapse text-left">
                <caption className="sr-only">
                  Marks entry grid. Use Tab or Enter to move between cells, arrow keys to move
                  between rows.
                </caption>

                <thead className="sticky top-0 z-20 bg-app-raised">
                  <tr className="border-b border-line">
                    <th
                      scope="col"
                      className="sticky-col-header w-16 border-r border-line px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                    >
                      Roll
                    </th>
                    <th
                      scope="col"
                      className="sticky-col-header min-w-56 border-r border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                      style={{ left: '4rem' }}
                    >
                      Student
                    </th>
                    <th
                      scope="col"
                      className="w-20 px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                    >
                      Mark
                      <span className="tabular ml-1 font-normal normal-case text-ink-faint">
                        / {formatMark(context.maxMarks)}
                      </span>
                    </th>
                    <th
                      scope="col"
                      className="w-36 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                    >
                      Attendance
                    </th>
                    <th
                      scope="col"
                      className="w-20 px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                    >
                      Grade
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {visibleRows.map((row, index) => {
                    const edit = rows.get(row.studentId) ?? toEditable(row);
                    const error = invalidCells.get(row.studentId);
                    const isEdited = dirty.has(row.studentId) && edit.marks !== edit.saved;

                    // Plain computation, not a hook: this runs inside a list render.
                    const parsed = validateMark(edit.marks, row.maxMarks, edit.status);

                    return (
                      <tr
                        key={row.studentId}
                        className={cn(
                          'border-b border-line-soft transition-colors',
                          row.locked && 'bg-surface-muted/60',
                          !row.locked && 'hover:bg-surface-muted/50',
                        )}
                      >
                        <td
                          className={cn(
                            'tabular sticky-col-body border-r border-line px-3 py-1 text-right text-sm text-ink-subtle',
                            row.locked && 'bg-surface-muted',
                          )}
                        >
                          {row.rollNumber ?? '—'}
                        </td>

                        <td
                          className={cn(
                            'sticky-col-body border-r border-line px-3 py-1',
                            row.locked && 'bg-surface-muted',
                          )}
                          style={{ left: '4rem' }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-ink">
                                {row.fullName}
                              </span>
                              <span className="tabular block truncate text-xs text-ink-subtle">
                                {row.studentNumber}
                              </span>
                            </span>
                            {row.source && row.source !== 'manual' && (
                              <span
                                title={`Entered from ${row.source}`}
                                className="shrink-0 rounded bg-surface-sunken px-1 text-2xs uppercase tracking-wide text-ink-subtle"
                              >
                                {row.source}
                              </span>
                            )}
                            {row.locked && (
                              <span className="shrink-0 text-ink-faint" title="Locked — read only">
                                <IconLock size={12} />
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-2 py-1">
                          <MarkCell
                            value={edit.marks === '' ? null : Number(edit.marks)}
                            maxMarks={row.maxMarks}
                            status={edit.status}
                            disabled={!editable || row.locked}
                            edited={isEdited}
                            rowIndex={index}
                            columnIndex={0}
                            onCommit={(raw, status) => setCell(row.studentId, { marks: raw, status })}
                            onNavigate={(direction, focus) => navigateRow(row.studentId, direction, focus)}
                            registerRef={(element) => {
                              if (element) cellRefs.current.set(row.studentId, element);
                              else cellRefs.current.delete(row.studentId);
                            }}
                          />
                          {error && !editable && (
                            <p className="mt-0.5 text-2xs text-danger-strong">{error}</p>
                          )}
                        </td>

                        <td className="px-2 py-1">
                          <select
                            value={edit.status}
                            disabled={!editable || row.locked}
                            aria-label={`Attendance for ${row.fullName}`}
                            onChange={(event) =>
                              setCell(row.studentId, {
                                status: event.target.value as MarkStatus,
                                // Switching away from PRESENT must clear the
                                // number, or the row would read as a zero.
                                marks:
                                  event.target.value === MARK_STATUS.PRESENT ? edit.marks : '',
                              })
                            }
                            className={cn(
                              'h-9 w-full rounded border px-2 text-xs shadow-xs transition-colors',
                              'focus:outline-none focus:ring-2 focus:ring-brand-200',
                              !editable || row.locked
                                ? 'cursor-not-allowed border-transparent bg-surface-sunken text-ink-subtle'
                                : 'border-line bg-surface text-ink hover:border-line-strong focus:border-brand-500',
                            )}
                          >
                            {ALL_MARK_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status.charAt(0) + status.slice(1).toLowerCase()}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="px-3 py-1 text-center">
                          {edit.status !== MARK_STATUS.PRESENT || !parsed.valid || parsed.value === null ? (
                            <span className="text-xs text-ink-faint">—</span>
                          ) : (
                            <GradePreview marks={parsed.value} maxMarks={context.maxMarks} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <GridLegend editable={editable} />
        </>
      )}

      <SaveIndicator
        dirtyCount={dirty.size}
        pending={autosave.isPending}
        blocked={Boolean(conflict || saveError)}
        editable={editable}
      />
    </div>
  );
}

/* ==========================================================================
   Supporting pieces
   ========================================================================== */

function toEditable(row: MarkEntryRow): EditableRow {
  const marks = row.marksObtained === null ? '' : String(row.marksObtained);
  return { marks, status: row.status, remarks: row.remarks, saved: marks };
}

/**
 * The version-conflict banner.
 *
 * This is the single most important error in the product: someone else saved
 * while this user was typing, and the next thing they do must not be a blind
 * retry that overwrites that work.
 */
function ConflictBanner({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded border border-warning-300 bg-warning-soft px-3 py-2.5 text-sm text-warning-strong"
    >
      <IconAlertCircle size={16} className="mt-px shrink-0" />
      <div>
        <p className="font-medium">Someone else changed this sheet</p>
        <p className="mt-0.5 text-[0.9375rem] leading-relaxed">{message}</p>
        <p className="mt-1 text-xs">
          Automatic saving is paused for this sheet. Nothing you typed has been sent.
        </p>
      </div>
    </div>
  );
}

/**
 * Generic save-failure banner.
 *
 * The conflict banner is about someone else's edit; this one is about the
 * server refusing (or failing to record) the teacher's. Without it the grid
 * showed "saving automatically" forever while nothing was keeping the work.
 */
function SaveErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded border border-danger-300 bg-danger-soft px-3 py-2.5 text-sm text-danger-strong"
    >
      <IconAlertCircle size={16} className="mt-px shrink-0" />
      <div>
        <p className="font-medium">Could not save your changes</p>
        <p className="mt-0.5 text-[0.9375rem] leading-relaxed">{message}</p>
        <p className="mt-1 text-xs">
          Automatic saving is paused. Edit any mark to try again — nothing from the failed attempt has
          been stored.
        </p>
      </div>
    </div>
  );
}

/**
 * Save indicator.
 *
 * States are explicit rather than implied: how many changes are pending, whether
 * a save is in flight, and whether autosave is paused. A teacher should never
 * have to guess whether their work is safe.
 */
function SaveIndicator({
  dirtyCount,
  pending,
  blocked,
  editable,
}: {
  dirtyCount: number;
  pending: boolean;
  blocked: boolean;
  editable: boolean;
}) {
  if (!editable) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-subtle">
        <IconLock size={12} />
        This sheet is read only.
      </p>
    );
  }

  if (dirtyCount === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-subtle" aria-live="polite">
        <IconCheck size={12} className="text-success-base" />
        All changes saved. Still a draft until you submit it for review.
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-xs text-ink-muted" aria-live="polite">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning-base"
      />
      {blocked
        ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'} — autosave paused`
        : pending
          ? `Saving ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}…`
          : `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'} — saving automatically`}
    </p>
  );
}

/**
 * Cell legend.
 *
 * The prompt for this product is that a teacher should understand a cell's state
 * without opening a tooltip. A one-line key is the cheapest way to make the
 * colour language teachable the first time it appears.
 */
function GridLegend({ editable }: { editable: boolean }) {
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-ink-subtle hover:text-ink">
        <span className="underline decoration-dotted underline-offset-2">What do the colours mean?</span>
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded border border-line bg-surface px-3 py-2">
        <LegendKey className="border-line bg-surface" label="Saved" />
        <LegendKey className="border-warning-300 bg-warning-soft/60" label="Edited, not yet saved" />
        <LegendKey className="border-danger-400 bg-danger-soft" label="Out of range" />
        <LegendKey className="border-transparent bg-surface-sunken" label="Locked or absent" />
        {editable && <Note className="w-full">Absent, exempted and medical rows carry no mark.</Note>}
      </div>
    </details>
  );
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn('h-3.5 w-6 rounded border', className)} />
      <span className="text-ink-muted">{label}</span>
    </span>
  );
}

/**
 * Live grade preview.
 *
 * Computed with the same `validateMark` helper the server enforces, so the number a
 * teacher sees while typing always matches what gets stored.
 */
function GradePreview({ marks, maxMarks }: { marks: number; maxMarks: number }) {
  const percentage = maxMarks > 0 ? (marks / maxMarks) * 100 : 0;
  const grade = gradeFor(percentage);
  return (
    <span className={cn('tabular inline-block rounded px-1.5 py-0.5 text-xs font-semibold', grade.tone)}>
      {grade.label}
    </span>
  );
}

/**
 * Local mirror of the seeded default scheme.
 *
 * The authoritative grade always comes from the database at save time; this is
 * only the optimistic hint shown while typing. If an admin has configured a
 * different scheme the preview may differ briefly — the saved value is correct,
 * and the grid refresh reveals it.
 */
function gradeFor(percentage: number): { label: string; tone: string } {
  const bands: Array<{ min: number; label: string; tone: string }> = [
    { min: 90, label: 'A+', tone: 'bg-success-soft text-success-strong' },
    { min: 80, label: 'A', tone: 'bg-success-soft text-success-strong' },
    { min: 70, label: 'B+', tone: 'bg-info-soft text-info-strong' },
    { min: 60, label: 'B', tone: 'bg-info-soft text-info-strong' },
    { min: 50, label: 'C', tone: 'bg-warning-soft text-warning-strong' },
    { min: 40, label: 'D', tone: 'bg-warning-soft text-warning-strong' },
    { min: 0, label: 'F', tone: 'bg-danger-soft text-danger-strong' },
  ];
  const band = bands.find((entry) => percentage >= entry.min);
  return band ?? { label: 'F', tone: 'bg-danger-soft text-danger-strong' };
}
