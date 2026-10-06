import type { Student, StudentStatus } from '@school/shared';
import { getSupabase } from '../supabase';
import {
  applySearch,
  camel,
  camelMany,
  orSearch,
  paginate,
  toQueryError,
  type ListParams,
  type ListResponse,
} from '../query';

/**
 * Students.
 *
 * A student row is scoped to one academic year (Business Rule 10), so almost
 * every query here takes an `academicYearId`. Promotion does not mutate a row —
 * it inserts a new one for the next year, leaving the previous year's result
 * exactly as it was.
 */

const SEARCHABLE = ['full_name', 'student_number', 'admission_number'];

export interface StudentFilters {
  academicYearId?: string;
  classId?: string;
  sectionId?: string;
  status?: string;
}

/**
 * Paged student list.
 *
 * Shaped for `useListQuery`'s `fetcher`, which owns paging and debounced search
 * and hands the merged params here.
 */
export async function listStudents(params: ListParams): Promise<ListResponse<Student>> {
  const { page, pageSize, academicYearId, classId, sectionId, status, search } = params;

  let q = getSupabase().from('v_students').select('*', { count: 'exact' });

  if (academicYearId) q = q.eq('academic_year_id', academicYearId);
  if (classId) q = q.eq('class_id', classId);
  if (sectionId) q = q.eq('section_id', sectionId);
  if (status) q = q.eq('status', status);

  q = applySearch(q, orSearch(SEARCHABLE, search as string | undefined));

  return paginate<Student, typeof q>(
    q.order('roll_number', { ascending: true, nullsFirst: false }).order('full_name'),
    { page: page as number, pageSize: pageSize as number },
  );
}

/**
 * Whole set for the current filter, capped.
 *
 * Used by the export screens, which need every matching row rather than a page.
 * The cap exists because an unbounded select against a real school is how you
 * time out a browser tab.
 */
export async function listAllStudents(filters: StudentFilters, cap = 5000): Promise<Student[]> {
  let q = getSupabase().from('v_students').select('*').limit(cap);

  if (filters.academicYearId) q = q.eq('academic_year_id', filters.academicYearId);
  if (filters.classId) q = q.eq('class_id', filters.classId);
  if (filters.sectionId) q = q.eq('section_id', filters.sectionId);
  if (filters.status) q = q.eq('status', filters.status);

  const { data, error } = await q.order('full_name');
  if (error) throw toQueryError(error);
  return camelMany<Student>(data);
}

export async function getStudent(id: string): Promise<Student | null> {
  const { data, error } = await getSupabase()
    .from('v_students')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toQueryError(error);
  return camel<Student>(data);
}

/**
 * Year-on-year history for one student.
 *
 * The student has one row per academic year, so "history" is every row sharing
 * their admission number (falling back to name + DOB for students enrolled before
 * admission numbers were captured).
 */
export async function getStudentHistory(studentId: string): Promise<StudentHistoryRow[]> {
  const student = await getStudent(studentId);
  if (!student) return [];

  let q = getSupabase().from('v_students').select('*');

  if (student.admissionNumber) {
    q = q.eq('admission_number', student.admissionNumber);
  } else {
    q = q.eq('normalized_name', student.fullName.toLowerCase().replace(/\s+/g, ''));
  }

  const { data, error } = await q.order('academic_year_name');
  if (error) throw toQueryError(error);

  const rows = camelMany<Student>(data);
  const results = await getResultsForStudent(rows.map((r) => r.id));

  return rows.map((row) => {
    const totals = results.get(row.id) ?? EMPTY_TOTALS;

    return {
      id: row.id,
      academicYearName: row.academicYearName ?? '',
      className: row.className ?? '',
      sectionName: row.sectionName ?? '',
      rollNumber: row.rollNumber,
      status: row.status,
      // Spread a fresh object: reusing the shared EMPTY_TOTALS reference would
      // let one row's aggregation mutate another's.
      ...totals,
    };
  });
}

/** Zeroed totals for a year with no marks. */
const EMPTY_TOTALS = {
  totalMarksObtained: 0,
  totalMaxMarks: 0,
  percentage: null,
  grade: null,
  isPass: null,
} as const;

export interface StudentHistoryTotals {
  totalMarksObtained: number;
  totalMaxMarks: number;
  percentage: number | null;
  grade: string | null;
  isPass: boolean | null;
}

export interface StudentHistoryRow extends StudentHistoryTotals {
  id: string;
  academicYearName: string;
  className: string;
  sectionName: string;
  rollNumber: number | null;
  /**
   * Enrolment status for that year — `active`, `graduated`, `transferred`.
   *
   * Distinct from a current status: a student can be `active` this year and
   * `graduated` on the row that recorded their final year.
   */
  status: StudentStatus;
}

/** Aggregate marks per student across every year in one query. */
async function getResultsForStudent(studentIds: string[]): Promise<Map<string, StudentHistoryTotals>> {
  const out = new Map<string, StudentHistoryTotals>();

  if (studentIds.length === 0) return out;

  const { data, error } = await getSupabase()
    .from('marks')
    .select('student_id, marks_obtained, max_marks, percentage, grade, is_pass')
    .in('student_id', studentIds);

  if (error) throw toQueryError(error);

  for (const row of data ?? []) {
    const id = row.student_id as string;
    const prev = out.get(id) ?? {
      totalMarksObtained: 0,
      totalMaxMarks: 0,
      percentage: null,
      grade: null,
      isPass: null,
    };

    const obtained = toNumber(row.marks_obtained);
    const max = toNumber(row.max_marks);

    prev.totalMarksObtained += obtained;
    prev.totalMaxMarks += max;
    if (row.grade) prev.grade = row.grade as string;
    if (typeof row.is_pass === 'boolean') prev.isPass = row.is_pass;

    out.set(id, prev);
  }

  // Percentage is computed here rather than averaged, because averaging
  // per-subject percentages weights a 20-mark paper the same as a 100-mark one.
  for (const value of out.values()) {
    value.percentage =
      value.totalMaxMarks > 0
        ? Math.round((value.totalMarksObtained / value.totalMaxMarks) * 100 * 100) / 100
        : null;
  }

  return out;
}

/**
 * Typeahead for the report and OCR screens.
 *
 * Narrower than `listStudents` and deliberately uncapped — it is a search box,
 * not a data dump, so the result set is small by construction.
 */
export async function quickSearchStudents(
  term: string,
  limit = 10,
): Promise<Array<Pick<Student, 'id' | 'fullName' | 'studentNumber' | 'className' | 'sectionName'>>> {
  if (!term.trim()) return [];

  let q = getSupabase().from('v_students').select('id, full_name, student_number, class_name, section_name');

  // An all-digit term is a student or admission number, not a name fragment.
  q = /^\d+$/.test(term.trim())
    ? q.or(`student_number.ilike.%${term.trim()}%,admission_number.ilike.%${term.trim()}%`)
    : applySearch(q, orSearch(['full_name'], term));

  const { data, error } = await q.limit(limit).order('full_name');
  if (error) throw toQueryError(error);
  return camelMany(data as Record<string, unknown>[]);
}

/** Roster for one section — used by marks entry and OCR matching. */
export async function listSectionRoster(sectionId: string): Promise<Student[]> {
  const { data, error } = await getSupabase()
    .from('v_students')
    .select('*')
    .eq('section_id', sectionId)
    .eq('status', 'active')
    .order('roll_number', { ascending: true, nullsFirst: false });

  if (error) throw toQueryError(error);
  return camelMany<Student>(data);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

/** Postgres `numeric` arrives as a string over PostgREST. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}