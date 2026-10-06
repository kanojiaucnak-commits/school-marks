import type {
  MarkEntryRow,
  MarkStatus,
  MarkSubmission,
  MarksGridResponse,
  SubmissionStatus,
} from '@school/shared';
import { getSupabase } from '../supabase';
import {
  applySearch,
  camel,
  camelMany,
  orSearch,
  paginate,
  QueryError,
  rpc,
  toQueryError,
  unwrap,
  type ListResponse,
} from '../query';

/**
 * Marks entry and the submission workflow.
 *
 * Reads go through views; writes go through the transactional functions in
 * `0004_functions.sql` rather than through PostgREST, because both operations
 * need several statements plus a version check to be atomic.
 */

export interface SheetContext {
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
}

export interface SaveGridResult {
  ok: boolean;
  code?: string;
  message?: string;
  submissionId?: string | null;
  version?: number | null;
  enteredCount?: number;
  average?: number | null;
}

/** Envelope returned by `apply_submission_transition()`. */
export interface TransitionResult {
  ok: boolean;
  code?: string;
  message?: string;
  status?: SubmissionStatus;
  version?: number;
}

/** Set (or clear, with `null`) the out-of for one sheet. */
export async function setSheetMax(ctx: SheetContext, maxMarks: number | null): Promise<void> {
  if (maxMarks === null) {
    // Clearing the override returns the sheet to the exam default; deleting the row
    // is simpler and safer than writing a zero or null into `max_marks`.
    const { error } = await getSupabase()
      .from('sheet_max_marks')
      .delete()
      .eq('academic_year_id', ctx.academicYearId)
      .eq('section_id', ctx.sectionId)
      .eq('subject_id', ctx.subjectId)
      .eq('exam_id', ctx.examId);
    if (error) throw toQueryError(error);
    return;
  }

  const { error } = await getSupabase()
    .from('sheet_max_marks')
    .upsert(
      {
        academic_year_id: ctx.academicYearId,
        class_id: ctx.classId,
        section_id: ctx.sectionId,
        subject_id: ctx.subjectId,
        exam_id: ctx.examId,
        max_marks: maxMarks,
      },
      { onConflict: 'academic_year_id,section_id,subject_id,exam_id' },
    );
  if (error) throw toQueryError(error);
}

/** Envelope returned by `save_marks_grid()`. */
export interface SaveGridEnvelope {
  ok: boolean;
  code?: string;
  message?: string;
  submissionId?: string | null;
  version?: number | null;
  enteredCount?: number;
  average?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The marks grid for one sheet: every student in the section, with their mark if
 * one exists.
 *
 * Built from the roster rather than from `marks`, so a student who has not been
 * marked still appears as an empty row. The outer join is what makes the grid
 * show "not entered" distinctly from "entered as absent" — a distinction that
 * matters, because one is a gap in the teacher's work and the other is a fact
 * about the student.
 */
export async function getMarksGrid(ctx: SheetContext): Promise<MarksGridResponse> {
  const [rosterRes, examRes, sheetMaxRes, submissionRes, marksRes] = await Promise.all([
    getSupabase()
      .from('v_students')
      .select('id, student_number, roll_number, full_name')
      .eq('section_id', ctx.sectionId)
      .eq('academic_year_id', ctx.academicYearId)
      .eq('status', 'active')
      .order('roll_number', { ascending: true, nullsFirst: false }),
    getSupabase().from('exams').select('*').eq('id', ctx.examId).maybeSingle(),
    getSupabase()
      .from('sheet_max_marks')
      .select('max_marks')
      .eq('academic_year_id', ctx.academicYearId)
      .eq('section_id', ctx.sectionId)
      .eq('subject_id', ctx.subjectId)
      .eq('exam_id', ctx.examId)
      .maybeSingle(),
    getSupabase()
      .from('v_submissions')
      .select('*')
      .eq('academic_year_id', ctx.academicYearId)
      .eq('section_id', ctx.sectionId)
      .eq('subject_id', ctx.subjectId)
      .eq('exam_id', ctx.examId)
      .maybeSingle(),
    getSupabase()
      .from('marks')
      .select('id, student_id, marks_obtained, status, grade, remarks, source')
      .eq('academic_year_id', ctx.academicYearId)
      .eq('subject_id', ctx.subjectId)
      .eq('exam_id', ctx.examId),
  ]);

  if (rosterRes.error) throw toQueryError(rosterRes.error);
  if (examRes.error) throw toQueryError(examRes.error);
  if (sheetMaxRes.error) throw toQueryError(sheetMaxRes.error);
  if (submissionRes.error) throw toQueryError(submissionRes.error);
  if (marksRes.error) throw toQueryError(marksRes.error);

  const exam = examRes.data;
  // A per-sheet override beats the exam-level default. This mirrors
  // `public.effective_max_marks`, which is what the server enforces.
  const override = sheetMaxRes.data as { max_marks: number | string } | null;
  const maxMarks = override
    ? Number(override.max_marks)
    : exam
      ? Number(exam.max_marks)
      : 0;
  const submission = camel<MarkSubmission>(submissionRes.data);
  const frozen = submission ? isFrozen(submission.status) : false;
  const hasSheetOverride = override !== null && override !== undefined;

  const marksByStudent = new Map<string, Record<string, unknown>>();
  for (const row of marksRes.data ?? []) {
    marksByStudent.set(row.student_id as string, row);
  }

  const rows: MarkEntryRow[] = camelMany<Record<string, unknown>>(rosterRes.data).map((student) => {
    const id = student.id as string;
    const mark = marksByStudent.get(id);

    // `camelMany` above has already renamed every key, so these reads must be
    // camelCase too. Reading the snake_case names here found `undefined` for all
    // three, which the grid rendered as a `NaN` roll (because
    // `undefined === null` is false, so `Number(undefined)` ran) and as a *blank*
    // student number and name — the teacher could not tell whose marks they were
    // editing, and the name filter matched nothing.
    return {
      studentId: id,
      studentNumber: String(student.studentNumber ?? ''),
      rollNumber: student.rollNumber === null || student.rollNumber === undefined
        ? null
        : Number(student.rollNumber),
      fullName: String(student.fullName ?? ''),
      markId: mark ? (mark.id as string) : null,
      maxMarks,
      marksObtained: mark?.marks_obtained === null || mark?.marks_obtained === undefined
        ? null
        : Number(mark.marks_obtained),
      status: ((mark?.status as MarkStatus) ?? 'PRESENT') as MarkStatus,
      grade: (mark?.grade as string | null) ?? null,
      remarks: (mark?.remarks as string | null) ?? null,
      source: (mark?.source as MarkEntryRow['source']) ?? null,
      // A row can exist while the sheet is frozen; the teacher must be able to
      // see their own earlier work without being able to change it.
      locked: frozen,
    };
  });

  return {
    academicYearId: ctx.academicYearId,
    classId: ctx.classId,
    sectionId: ctx.sectionId,
    subjectId: ctx.subjectId,
    examId: ctx.examId,
    maxMarks,
    hasSheetOverride,
    submission,
    rows,
    editable: !frozen,
  };
}

/**
 * Save dirty rows.
 *
 * Only rows the teacher actually changed are sent, and `expectedVersion` is
 * passed through so a stale tab cannot clobber a newer sheet. A version mismatch
 * comes back as `{ok: false, code: 'CONFLICT'}` rather than an exception, which
 * is what lets the grid tell "someone else edited this" apart from "you lack
 * permission" — two problems with very different fixes.
 */
export async function saveMarksGrid(input: {
  ctx: SheetContext;
  rows: Array<{
    studentId: string;
    marks: number | null;
    status: MarkStatus;
    remarks?: string | null;
  }>;
  expectedVersion?: number | null;
  comments?: string | null;
}): Promise<SaveGridResult> {
  if (input.rows.length === 0) {
    return { ok: true, message: 'No changes to save.' };
  }

  const result = await rpc<SaveGridResult>('save_marks_grid', {
    p_section_id: input.ctx.sectionId,
    p_subject_id: input.ctx.subjectId,
    p_exam_id: input.ctx.examId,
    p_academic_year_id: input.ctx.academicYearId,
    p_rows: input.rows,
    p_expected_version: input.expectedVersion ?? null,
    p_comments: input.comments ?? null,
  });

  // `save_marks_grid` returns jsonb, so PostgREST hands back the envelope
  // object. A null here would mean the function reported nothing at all,
  // which is not a success the grid can act on.
  if (!result) {
    throw new QueryError('NO_RESULT', 'The marks could not be saved. Try again.');
  }
  return result;
}

/**
 * Throws on a refused save, for callers that treat any refusal as an error.
 *
 * `saveMarksGrid` deliberately returns the envelope instead of throwing, because
 * the grid must distinguish three outcomes: saved, version conflict (show "someone
 * else edited this"), and not editable (ask them to request a return). This
 * wrapper is for the simpler callers — the submit bar, bulk actions — where a
 * refusal is just an error.
 */
export async function saveMarksGridOrThrow(input: Parameters<typeof saveMarksGrid>[0]) {
  return unwrap(await saveMarksGrid(input));
}

/**
 * Move a sheet through the review workflow.
 *
 * Throws on refusal so callers do not have to check `ok` themselves — a silently
 * ignored `{ok: false}` here would let a reviewer believe they had approved a
 * sheet that was refused.
 */
export async function transitionSubmission(input: {
  submissionId: string;
  to: SubmissionStatus;
  comments?: string | null;
  expectedVersion?: number | null;
}): Promise<TransitionResult> {
  const result = await rpc<TransitionResult>('apply_submission_transition', {
    p_submission_id: input.submissionId,
    p_to: input.to,
    p_comments: input.comments ?? null,
    p_expected_version: input.expectedVersion ?? null,
  });

  // Same shape as `saveMarksGrid`: jsonb in, object out. A null is treated as a
  // refusal, because a transition that produced no envelope has not happened and
  // must not read as success.
  return unwrap(
    result ?? { ok: false, code: 'NO_RESULT', message: 'That action was refused.' },
  );
}

/** Convenience wrappers for each legal transition. */
export const submitSheet = (submissionId: string, expectedVersion?: number | null, comments?: string) =>
  transitionSubmission({ submissionId, to: 'SUBMITTED', expectedVersion, comments });

export const startReview = (submissionId: string, expectedVersion?: number | null) =>
  transitionSubmission({ submissionId, to: 'UNDER_REVIEW', expectedVersion });

export const approveSheet = (submissionId: string, expectedVersion?: number | null, comments?: string) =>
  transitionSubmission({ submissionId, to: 'APPROVED', expectedVersion, comments });

export const rejectSheet = (submissionId: string, expectedVersion?: number | null, comments?: string) =>
  transitionSubmission({ submissionId, to: 'REJECTED', expectedVersion, comments });

export const returnSheet = (submissionId: string, expectedVersion?: number | null, comments?: string) =>
  transitionSubmission({ submissionId, to: 'RETURNED', expectedVersion, comments });

export const lockSheet = (submissionId: string, expectedVersion?: number | null, comments?: string) =>
  transitionSubmission({ submissionId, to: 'LOCKED', expectedVersion, comments });

/* -------------------------------------------------------------------------- */
/* Submission lists                                                             */
/* -------------------------------------------------------------------------- */

export interface SubmissionFilters {
  academicYearId?: string;
  status?: string;
  search?: string;
  /** Restrict to one teacher. Used by the teacher dashboard. */
  teacherId?: string;
}

/**
 * Sheets awaiting action, bounded.
 *
 * RLS already removes rows a caller may not see, so a reviewer sees every sheet
 * and a teacher sees only their own assignments. No permission branch is needed
 * here, and adding one would risk diverging from the policies.
 *
 * This returns at most `limit` rows and does *not* report a total, so it must not
 * be used to drive pagination — a caller doing so silently loses everything past
 * the cap, which is exactly the bug this function used to have. Use
 * {@link paginateSubmissions} for anything that pages.
 */
export async function listSubmissions(
  params: SubmissionFilters,
  limit = 500,
): Promise<MarkSubmission[]> {
  let q = getSupabase().from('v_submissions').select('*');

  if (params.academicYearId) q = q.eq('academic_year_id', params.academicYearId);
  if (params.teacherId) q = q.eq('teacher_id', params.teacherId);

  if (params.status) {
    // The UI passes a comma-separated list from a multi-select.
    const statuses = params.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) q = q.in('status', statuses);
  }

  // The reviewer queue's placeholder promises "Teacher, subject or exam", so the
  // teacher's name and email are searchable too — not just the sheet's labels.
  q = applySearch(
    q,
    orSearch(
      ['subject_name', 'exam_name', 'class_name', 'section_name', 'teacher_name', 'teacher_email'],
      params.search,
    ),
  );

  const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit);
  if (error) throw toQueryError(error);
  return camelMany<MarkSubmission>(data);
}

/**
 * One page of the queue, with a real total.
 *
 * Paging happens in Postgres. The previous version fetched the caller's entire
 * queue and sliced it in the browser under a 200-row cap, so with more sheets than
 * that the queue was not merely mis-paged — the extra sheets did not exist as far
 * as the reviewer was concerned, and the count they saw was wrong too.
 */
export async function paginateSubmissions(
  params: SubmissionFilters,
  page: number,
  pageSize: number,
): Promise<ListResponse<MarkSubmission>> {
  let q = getSupabase().from('v_submissions').select('*');

  if (params.academicYearId) q = q.eq('academic_year_id', params.academicYearId);
  if (params.teacherId) q = q.eq('teacher_id', params.teacherId);

  if (params.status) {
    const statuses = params.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) q = q.in('status', statuses);
  }

  q = applySearch(
    q,
    orSearch(
      ['subject_name', 'exam_name', 'class_name', 'section_name', 'teacher_name', 'teacher_email'],
      params.search,
    ),
  );

  return paginate<MarkSubmission, typeof q>(
    q.order('updated_at', { ascending: false }),
    { page, pageSize },
  );
}

export async function getSubmission(id: string): Promise<MarkSubmission | null> {
  const { data, error } = await getSupabase().from('v_submissions').select('*').eq('id', id).maybeSingle();
  if (error) throw toQueryError(error);
  return camel<MarkSubmission>(data);
}

/** Counts for the reviewer queue badges. */
export async function getSubmissionCounts(academicYearId?: string): Promise<Record<string, number>> {
  let q = getSupabase().from('v_submissions').select('status');
  if (academicYearId) q = q.eq('academic_year_id', academicYearId);

  const { data, error } = await q;
  if (error) throw toQueryError(error);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const status = row.status as string;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Subjects the caller may mark for a section, derived from their assignments. */
export async function listSubjectsForSheet(
  sectionId: string,
  academicYearId: string,
): Promise<Array<{ id: string; name: string; code: string }>> {
  const { data, error } = await getSupabase()
    .from('v_teacher_assignments')
    .select('subject_id, subject_name, subject_code')
    .eq('section_id', sectionId)
    .eq('academic_year_id', academicYearId);

  if (error) throw toQueryError(error);

  // The same subject can be assigned by more than one teacher; de-duplicate.
  const seen = new Map<string, { id: string; name: string; code: string }>();
  for (const row of data ?? []) {
    const id = row.subject_id as string;
    if (!seen.has(id)) {
      seen.set(id, { id, name: row.subject_name as string, code: row.subject_code as string });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Statuses in which marks are frozen. Mirrors FROZEN_SUBMISSION_STATUSES. */
function isFrozen(status: SubmissionStatus): boolean {
  return status === 'APPROVED' || status === 'LOCKED';
}