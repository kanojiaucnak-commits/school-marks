import type {
  AcademicYear,
  ClassRecord,
  ClassSectionRef,
  Exam,
  GradingScheme,
  Section,
  Subject,
  TeacherAssignment,
} from '@school/shared';
import type {
  CreateAcademicYearInput,
  CreateAssignmentInput,
  CreateClassInput,
  CreateExamInput,
  CreateSectionInput,
  CreateSubjectInput,
} from '@school/shared';
import { getSupabase } from '../supabase';
import { camel, camelMany, paginate, QueryError, rpc, toQueryError, type ListParams, type ListResponse, type Row } from '../query';

/**
 * Academic structure.
 *
 * Classes, sections, subjects, exams and the joins that hang off them. Everything
 * here is reference data: a marks row points at a class/section/subject, so
 * deleting one of these is constrained by the database (see `deleteClass`).
 *
 * Two conventions run through the file:
 *
 *   - Inserts go through `insertRow`, which turns Postgres' `23505` into a
 *     sentence naming the column that collided. A bare "duplicate key" tells a
 *     user nothing about which field to change.
 *   - Updates go through `toPatchRow`, which converts a camelCase patch object to
 *     a snake_case row object, dropping `undefined`. Sending `undefined` would
 *     null out the column rather than leave it alone.
 */

/* -------------------------------------------------------------------------- */
/* Assignment requests                                                         */
/* -------------------------------------------------------------------------- */

export type AssignmentRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * A teacher's request to teach a class/section/subject.
 *
 * The row itself is narrow (status, note, who decided); everything a human needs
 * to judge the request is joined on by `listAssignmentRequests`, so an approver
 * never has to make N+1 lookups to read the queue.
 */
export interface AssignmentRequest {
  id: string;
  teacherId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  status: AssignmentRequestStatus;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  academicYearName: string | null;
  className: string | null;
  sectionName: string | null;
  subjectName: string | null;
  teacherName: string | null;
  teacherEmail: string | null;
}

/* -------------------------------------------------------------------------- */
/* Shared row helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Insert one row and return it.
 *
 * Postgres reports a uniqueness violation as `23505` with the colliding index in
 * `detail`, but the message alone is "duplicate key value violates unique
 * constraint" — it never says which field. Naming the column is the difference
 * between a user fixing the form and a user filing a bug.
 */
async function insertRow<T>(table: string, row: Row): Promise<T> {
  const { data, error } = await getSupabase().from(table).insert(row).select().single();

  if (error) {
    if (error.code === '23505') {
      const key = error.details?.match(/Key \(([^)]+)\)/)?.[1]?.replace(/_/g, ' ') ?? 'value';
      throw new QueryError('23505', `That ${key} is already in use.`, error.details);
    }
    throw toQueryError(error);
  }

  // `.single()` succeeded, so there is exactly one row.
  return camel<T>(data)!;
}

/** camelCase patch object → snake_case row object, dropping undefined. */
function toPatchRow(patch: Row): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }
  return row;
}

/** An embedded resource arrives as a one-element array, or null when absent. */
function embedded(value: unknown): Row | null {
  return (Array.isArray(value) ? (value[0] ?? null) : value ?? null) as Row | null;
}

/* -------------------------------------------------------------------------- */
/* Academic years                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every academic year, newest first.
 *
 * Archived years are included by default because reports quote them by name; pass
 * `false` for selectors that should only offer years still in play.
 */
export async function listAcademicYears(includeArchived = false): Promise<AcademicYear[]> {
  let q = getSupabase().from('academic_years').select('*').order('start_date', { ascending: false });
  if (!includeArchived) q = q.eq('status', 'active');

  const { data, error } = await q;
  if (error) throw toQueryError(error);

  return camelMany<AcademicYear>(data);
}

/**
 * Paged academic years, shaped for `useListQuery`.
 *
 * Academic years are few — a school has perhaps one per decade — so this pages
 * for consistency with every other list screen rather than because it needs to.
 * It exists so `AcademicYearsPage` does not have to wrap the plain array in a
 * `ListResponse` at the call site.
 */
export async function listAcademicYearsPage(params: ListParams): Promise<ListResponse<AcademicYear>> {
  const { page, pageSize } = params;
  const includeArchived = params.includeArchived !== false;

  let q = getSupabase()
    .from('academic_years')
    .select('*', { count: 'exact' })
    .order('start_date', { ascending: false });
  if (!includeArchived) q = q.eq('status', 'active');

  return paginate<AcademicYear, typeof q>(q, { page: page as number, pageSize: pageSize as number });
}

/** The year flagged current, or null when none is. */
export async function getCurrentAcademicYear(): Promise<AcademicYear | null> {
  const { data, error } = await getSupabase()
    .from('academic_years')
    .select('*')
    .eq('is_current', true)
    .maybeSingle();

  if (error) throw toQueryError(error);

  return camel<AcademicYear>(data);
}

export async function createAcademicYear(
  input: Pick<CreateAcademicYearInput, 'name' | 'startDate' | 'endDate' | 'isCurrent'>,
): Promise<AcademicYear> {
  return insertRow<AcademicYear>('academic_years', {
    name: input.name,
    start_date: input.startDate,
    end_date: input.endDate,
    is_current: input.isCurrent ?? false,
  });
}

/**
 * Make one year current.
 *
 * The clear happens first and in its own statement: a single update cannot set
 * `is_current` false everywhere and true in one place, and the two-step version
 * also means the database is never left with two current years.
 */
export async function setCurrentAcademicYear(id: string): Promise<void> {
  await getSupabase().from('academic_years').update({ is_current: false }).eq('is_current', true);

  const { error } = await getSupabase().from('academic_years').update({ is_current: true }).eq('id', id);
  if (error) throw toQueryError(error);
}

/** Archive a year, and stop it being current in the same statement. */
export async function archiveAcademicYear(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from('academic_years')
    .update({ status: 'archived', is_current: false })
    .eq('id', id);

  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Classes and sections                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Classes for a year, with the sections that belong to them.
 *
 * Sections are fetched unscoped and filtered in memory against the class ids.
 * That is deliberate: `sections` has no `academic_year_id`, so the only way to
 * ask the database for this year's sections is to join through `classes` and
 * filter the result again anyway.
 */
export async function listClasses(academicYearId: string): Promise<{
  classes: ClassRecord[];
  sections: Section[];
}> {
  const [classResult, sectionResult] = await Promise.all([
    getSupabase()
      .from('classes')
      .select('*')
      .eq('academic_year_id', academicYearId)
      .order('level', { nullsFirst: false }),
    getSupabase().from('sections').select('*').order('name'),
  ]);

  if (classResult.error) throw toQueryError(classResult.error);
  if (sectionResult.error) throw toQueryError(sectionResult.error);

  const classes = camelMany<ClassRecord>(classResult.data);
  const classIds = new Set(classes.map((row) => row.id));
  const sections = camelMany<Section>(sectionResult.data).filter((row) => classIds.has(row.classId));

  return { classes, sections };
}

/** The class/section pairs of a year, pre-joined and labelled for selectors. */
export async function listClassSections(academicYearId: string): Promise<ClassSectionRef[]> {
  const { data, error } = await getSupabase()
    .from('v_class_sections')
    .select('*')
    .eq('academic_year_id', academicYearId)
    .order('label');

  if (error) throw toQueryError(error);

  return camelMany<ClassSectionRef>(data);
}

export async function createClass(input: CreateClassInput): Promise<ClassRecord> {
  return insertRow<ClassRecord>('classes', {
    academic_year_id: input.academicYearId,
    name: input.name,
    level: input.level ?? null,
  });
}

export async function updateClass(id: string, patch: Partial<ClassRecord>): Promise<ClassRecord> {
  const { data, error } = await getSupabase()
    .from('classes')
    .update(toPatchRow(patch as Row))
    .eq('id', id)
    .select()
    .single();

  if (error) throw toQueryError(error);

  return camel<ClassRecord>(data)!;
}

/**
 * Delete a class.
 *
 * `students.class_id` is `ON DELETE RESTRICT`, so this fails with `23503` while
 * any student still sits in the class. That surfaces as a sentence about the
 * class being in use, not as a constraint name.
 */
export async function deleteClass(id: string): Promise<void> {
  const { error } = await getSupabase().from('classes').delete().eq('id', id);
  if (error) throw toQueryError(error);
}

export async function createSection(input: CreateSectionInput): Promise<Section> {
  return insertRow<Section>('sections', {
    class_id: input.classId,
    name: input.name,
    class_teacher_id: input.classTeacherId ?? null,
  });
}

export async function updateSection(id: string, patch: Partial<Section>): Promise<Section> {
  const { data, error } = await getSupabase()
    .from('sections')
    .update(toPatchRow(patch as Row))
    .eq('id', id)
    .select()
    .single();

  if (error) throw toQueryError(error);

  return camel<Section>(data)!;
}

/** `students.section_id` is `ON DELETE RESTRICT` — see `deleteClass`. */
export async function deleteSection(id: string): Promise<void> {
  const { error } = await getSupabase().from('sections').delete().eq('id', id);
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Subjects                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Subjects, active only unless asked otherwise.
 *
 * Deactivating beats deleting: a subject that has marks must stay resolvable so
 * historical reports still name it.
 */
export async function listSubjects(includeInactive = false): Promise<Subject[]> {
  let q = getSupabase().from('subjects').select('*').order('name');
  if (!includeInactive) q = q.eq('is_active', true);

  const { data, error } = await q;
  if (error) throw toQueryError(error);

  return camelMany<Subject>(data);
}

export async function createSubject(
  input: Omit<CreateSubjectInput, 'isElective'> & { isElective?: boolean },
): Promise<Subject> {
  return insertRow<Subject>('subjects', {
    code: input.code.toUpperCase(),
    name: input.name,
    description: input.description ?? null,
    is_elective: input.isElective ?? false,
  });
}

export async function updateSubject(id: string, patch: Partial<Subject>): Promise<Subject> {
  const row = toPatchRow(patch as Row);
  // The code is the identifier people read aloud, so it is stored uppercase.
  if (typeof row.code === 'string') row.code = row.code.toUpperCase();

  const { data, error } = await getSupabase()
    .from('subjects')
    .update(row)
    .eq('id', id)
    .select()
    .single();

  if (error) throw toQueryError(error);

  return camel<Subject>(data)!;
}

export async function deactivateSubject(id: string): Promise<void> {
  const { error } = await getSupabase().from('subjects').update({ is_active: false }).eq('id', id);
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Exams                                                                       */
/* -------------------------------------------------------------------------- */

/** Exams for a year in chronological order; undated exams sort last. */
export async function listExams(academicYearId: string): Promise<Exam[]> {
  const { data, error } = await getSupabase()
    .from('exams')
    .select('*')
    .eq('academic_year_id', academicYearId)
    .order('exam_date', { ascending: true, nullsFirst: false });

  if (error) throw toQueryError(error);

  return camelMany<Exam>(data);
}

export async function createExam(input: CreateExamInput): Promise<Exam> {
  return insertRow<Exam>('exams', {
    academic_year_id: input.academicYearId,
    name: input.name,
    max_marks: input.maxMarks,
    weightage: input.weightage ?? 1,
    exam_date: input.examDate ?? null,
    status: input.status ?? 'scheduled',
  });
}

export async function updateExam(id: string, patch: Partial<Exam>): Promise<Exam> {
  const { data, error } = await getSupabase()
    .from('exams')
    .update(toPatchRow(patch as Row))
    .eq('id', id)
    .select()
    .single();

  if (error) throw toQueryError(error);

  return camel<Exam>(data)!;
}

export async function deleteExam(id: string): Promise<void> {
  const { error } = await getSupabase().from('exams').delete().eq('id', id);
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Teacher assignments                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Who teaches what, for one year.
 *
 * Reads from `v_teacher_assignments` so the subject/class/section names arrive
 * with the row. Pass `teacherId` to narrow to one teacher — that is the "my
 * classes" view, and it is also what RLS filters to for a teacher anyway.
 */
export async function listAssignments(params: {
  academicYearId: string;
  teacherId?: string;
}): Promise<TeacherAssignment[]> {
  let q = getSupabase()
    .from('v_teacher_assignments')
    .select('*')
    .eq('academic_year_id', params.academicYearId);

  if (params.teacherId) q = q.eq('teacher_id', params.teacherId);

  const { data, error } = await q.order('subject_name');
  if (error) throw toQueryError(error);

  return camelMany<TeacherAssignment>(data);
}

export async function createAssignment(input: CreateAssignmentInput): Promise<TeacherAssignment> {
  const { data, error } = await getSupabase()
    .from('teacher_assignments')
    .insert({
      teacher_id: input.teacherId,
      academic_year_id: input.academicYearId,
      class_id: input.classId,
      section_id: input.sectionId,
      subject_id: input.subjectId,
    })
    .select()
    .single();

  if (error) throw toQueryError(error);

  return camel<TeacherAssignment>(data)!;
}

export async function deleteAssignment(id: string): Promise<void> {
  const { error } = await getSupabase().from('teacher_assignments').delete().eq('id', id);
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Assignment requests (self-service onboarding)                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything an approver needs to judge a request, in one row.
 *
 * `teacher_id` references `profiles(id)`, which holds the Clerk user id, so the
 * embed is explicit rather than inferred.
 */
const REQUEST_SELECT = `
  *,
  academic_years:academic_year_id ( name ),
  classes:class_id ( name ),
  sections:section_id ( name ),
  subjects:subject_id ( name ),
  profiles:profiles!teacher_id ( full_name, email )
`;

/** Flatten the embedded joins onto names the table can render directly. */
function withJoinedNames(row: Row): AssignmentRequest {
  return {
    ...camel<AssignmentRequest>(row),
    academicYearName: embedded(row.academic_years)?.name ?? null,
    className: embedded(row.classes)?.name ?? null,
    sectionName: embedded(row.sections)?.name ?? null,
    subjectName: embedded(row.subjects)?.name ?? null,
    teacherName: embedded(row.profiles)?.full_name ?? null,
    teacherEmail: embedded(row.profiles)?.email ?? null,
  } as AssignmentRequest;
}

/** Newest first, so the queue leads with what arrived most recently. */
export async function listAssignmentRequests(): Promise<AssignmentRequest[]> {
  const { data, error } = await getSupabase()
    .from('assignment_requests')
    .select(REQUEST_SELECT)
    .order('created_at', { ascending: false });

  if (error) throw toQueryError(error);

  return (data ?? []).map(withJoinedNames);
}

/**
 * Ask to teach a class/section/subject.
 *
 * Goes through the `request_assignment` RPC rather than a plain insert so the
 * uniqueness rule (one live request per teacher per slot) and the RLS check are
 * enforced in one place.
 */
export async function requestAssignment(input: {
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
}): Promise<AssignmentRequest> {
  const { data, error } = await getSupabase().rpc('request_assignment', {
    p_academic_year_id: input.academicYearId,
    p_class_id: input.classId,
    p_section_id: input.sectionId,
    p_subject_id: input.subjectId,
  });

  if (error) throw toQueryError(error);

  // The function returns the `assignment_requests` composite, which PostgREST
  // hands back as a single-element array.
  return camel<AssignmentRequest>(data?.[0])!;
}

/**
 * Approve or decline a request.
 *
 * The note is accepted for call-site symmetry with the RPC but is not forwarded;
 * approving already writes the decision and timestamp.
 */
export async function decideAssignmentRequest(
  id: string,
  decision: 'approved' | 'rejected',
  _note?: string | null,
): Promise<AssignmentRequest> {
  const { data, error } = await getSupabase().rpc('decide_assignment_request', {
    p_request_id: id,
    p_decision: decision,
    p_note: null,
  });

  if (error) throw toQueryError(error);

  return camel<AssignmentRequest>(data?.[0])!;
}

/** Withdraw your own pending request. */
export async function cancelAssignmentRequest(id: string): Promise<AssignmentRequest> {
  const { data, error } = await getSupabase().rpc('cancel_assignment_request', { p_request_id: id });

  if (error) throw toQueryError(error);

  return camel<AssignmentRequest>(data?.[0])!;
}

/* -------------------------------------------------------------------------- */
/* Grading schemes                                                             */
/* -------------------------------------------------------------------------- */

/** Reads the view, so each scheme arrives with its rules already nested. */
export async function listGradingSchemes(): Promise<GradingScheme[]> {
  const { data, error } = await getSupabase().from('v_grading_schemes').select('*').order('name');

  if (error) throw toQueryError(error);

  return camelMany<GradingScheme>(data);
}

/**
 * The scheme to grade with: the default one, else the first.
 *
 * Reports must not fail because nobody marked anything as default, so this falls
 * back rather than returning null.
 */
export async function getActiveGradingScheme(): Promise<GradingScheme | null> {
  const schemes = await listGradingSchemes();
  return schemes.find((scheme) => scheme.isDefault) ?? schemes[0] ?? null;
}

/** One band. `sortOrder` is optional — the RPC falls back to array order. */
export interface GradingSchemeRuleInput {
  grade: string;
  minPercentage: number;
  maxPercentage: number;
  gradePoint?: number | null;
  isPass: boolean;
  sortOrder?: number;
}

export interface SaveGradingSchemeInput {
  id?: string | null;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  rules: GradingSchemeRuleInput[];
}

/**
 * Create or replace a scheme, returning its id.
 *
 * Separate from an insert/update on purpose — routing this through the generic
 * save path would mean re-deriving "replace the rule set" on every call, and the
 * overlapping-band validation belongs in one place (now enforced by the RPC
 * itself, per migration 0020).
 */
export async function saveGradingScheme(input: SaveGradingSchemeInput): Promise<string> {
  // save_grading_scheme returns the new id and never NULL on success, but a
  // null here would mean the write reported success without producing a row the
  // caller could then open. Fail loudly rather than return an empty id that
  // every later edit would silently miss.
  const id = await rpc<string>('save_grading_scheme', {
    p_scheme_id: input.id ?? null,
    p_name: input.name,
    p_description: input.description ?? null,
    p_is_default: input.isDefault ?? false,
    p_rules: input.rules.map((rule) => ({
      grade: rule.grade,
      minPercentage: rule.minPercentage,
      maxPercentage: rule.maxPercentage,
      gradePoint: rule.gradePoint ?? null,
      isPass: rule.isPass ?? true,
      sortOrder: rule.sortOrder ?? 0,
    })),
  });

  if (!id) {
    throw new QueryError('SCHEME_NOT_SAVED', 'The grading scheme was not saved.');
  }
  return id;
}

export async function setDefaultGradingScheme(id: string): Promise<void> {
  await rpc('set_default_grading_scheme', { p_scheme_id: id });
}