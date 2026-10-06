import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  PERMISSIONS,
  type GradingRule,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { edgeFetch, openPrintableReport } from '../../lib/edge';
import { camelMany, QueryError, toQueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import {
  getActiveGradingScheme,
  listAcademicYears,
  listClassSections,
  listExams,
  listSubjects,
} from '../../lib/repos/academic';
import { getStudent, quickSearchStudents } from '../../lib/repos/students';
import { getSupabase } from '../../lib/supabase';
import { formatMark, formatPercent, pluralise } from '../../lib/utils';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, CardHeader, StatTile, Table, Tabs, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useToast } from '../../components/ui/Toast';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { SubjectAverageChart } from '../../components/charts/Charts';
import { IconChart, IconDownload, IconFile, IconPrinter } from '../../components/ui/icons';

/**
 * Reports.
 *
 * Three scopes — student, class and subject — sharing one selector block.
 *
 * The figures on screen are assembled here from `v_marksheet`, the one view that
 * already joins students, subjects, exams and marks together; RLS still decides
 * which rows the caller can read, so a teacher cannot see a section they do not
 * teach. Printing and downloading are a different path: `report-generate` builds
 * the document server-side and the browser prints or saves it, which is what
 * "PDF export" has always meant in this app.
 *
 * For very large reports the Exports page queues the work instead.
 */
export default function ReportsPage() {
  const { user } = useAuth();
  const { success, error: errorToast } = useToast();
  const [searchParams] = useSearchParams();

  const [academicYearId, setAcademicYearId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [examId, setExamId] = useState('');
  const [tab, setTab] = useState('subject');
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState(searchParams.get('studentId') ?? '');

  const { data: yearsData } = useAcademicYears();

  useEffect(() => {
    if (!academicYearId && yearsData?.current) setAcademicYearId(yearsData.current.id);
  }, [yearsData, academicYearId]);

  const { data: classSections } = useQuery({
    queryKey: ['class-sections', academicYearId],
    queryFn: () => listClassSections(academicYearId),
    enabled: Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });

  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => listSubjects(),
    staleTime: 10 * 60_000,
  });

  const { data: exams } = useQuery({
    queryKey: ['exams', academicYearId],
    queryFn: () => listExams(academicYearId),
    enabled: Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (exams?.length && !exams.some((exam) => exam.id === examId)) {
      setExamId(exams[0]?.id ?? '');
    }
  }, [exams, examId]);

  const { data: studentsResult } = useQuery({
    queryKey: ['students', 'search', studentSearch],
    queryFn: () => quickSearchStudents(studentSearch),
    enabled: studentSearch.trim().length >= 2,
    staleTime: 30_000,
  });

  const scopeReady = Boolean(academicYearId && sectionId && subjectId && examId);
  const classSectionsList = classSections ?? [];

  /**
   * The labels the report headers show.
   *
   * Resolved from the selectors the user just chose from, so a report can never
   * be headed with a subject name that disagrees with the dropdown above it.
   */
  const labels: ReportLabels = useMemo(
    () => ({
      academicYearName: yearsData?.academicYears.find((year) => year.id === academicYearId)?.name ?? '',
      sectionName: classSectionsList.find((entry) => entry.sectionId === sectionId)?.sectionName ?? '',
      subjectName: subjects?.find((subject) => subject.id === subjectId)?.name ?? '',
      subjectCode: subjects?.find((subject) => subject.id === subjectId)?.code ?? '',
      examName: exams?.find((exam) => exam.id === examId)?.name ?? '',
    }),
    [yearsData, academicYearId, classSectionsList, sectionId, subjects, subjectId, exams, examId],
  );

  const { data: subjectReport, isLoading, error } = useQuery({
    queryKey: ['report', 'subject', academicYearId, sectionId, subjectId, examId],
    queryFn: () => loadSubjectReport({ academicYearId, sectionId, subjectId, examId, labels }),
    enabled: tab === 'subject' && scopeReady,
  });

  const { data: classReport, isLoading: classLoading, error: classError } = useQuery({
    queryKey: ['report', 'class', academicYearId, sectionId, examId],
    queryFn: () => loadClassReport({ academicYearId, sectionId, examId, labels }),
    enabled: tab === 'class' && Boolean(academicYearId && sectionId && examId),
  });

  const { data: studentReport, isLoading: studentLoading, error: studentError } = useQuery({
    queryKey: ['report', 'student', selectedStudentId, academicYearId],
    queryFn: () => loadStudentReport({ academicYearId, studentId: selectedStudentId }),
    enabled: tab === 'student' && Boolean(selectedStudentId),
  });

  const handlePrint = async () => {
    try {
      const body = printableBody(tab, { academicYearId, sectionId, subjectId, examId, studentId: selectedStudentId });
      if (!body) return;
      await openPrintableReport('report-generate', { ...body, format: 'html' });
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not open the report.');
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    try {
      const body = printableBody(tab, { academicYearId, sectionId, subjectId, examId, studentId: selectedStudentId });
      if (!body) return;
      await downloadReport(body, format, downloadName(tab));
      success('Export downloaded');
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'The export failed.');
    }
  };

  const items: Array<{ id: string; label: string; content: React.ReactNode }> = [
    {
      id: 'subject',
      label: 'Subject report',
      content: (
        <SubjectReportView
          report={subjectReport}
          loading={isLoading}
          error={error instanceof QueryError ? error.userMessage : null}
        />
      ),
    },
    {
      id: 'class',
      label: 'Class report',
      content: (
        <ClassReportView
          report={classReport}
          loading={classLoading}
          error={classError instanceof QueryError ? classError.userMessage : null}
        />
      ),
    },
    {
      id: 'student',
      label: 'Student report card',
      content: (
        <StudentReportView
          report={studentReport}
          loading={studentLoading}
          error={studentError instanceof QueryError ? studentError.userMessage : null}
          selectedStudentId={selectedStudentId}
          onSelectStudent={setSelectedStudentId}
          search={studentSearch}
          onSearch={setStudentSearch}
          results={studentsResult ?? []}
        />
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Generate, print and export examination results.
          </h1>
        </div>

        <div className="flex gap-2">
          <Button size="sm" icon={<IconPrinter size={15} />} onClick={handlePrint}>
            Print / PDF
          </Button>
          <Button size="sm" icon={<IconDownload size={15} />} onClick={() => handleExport('csv')}>
            CSV
          </Button>
          <Button
            size="sm"
            icon={<IconDownload size={15} />}
            // "Excel" rather than "XLSX": the file is a real workbook, and a
            // reader who does not know the extension is better served by the name
            // they will recognise than by the MIME type behind it.
            onClick={() => handleExport('xlsx')}
          >
            Excel
          </Button>
        </div>
      </header>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Academic year"
            value={academicYearId}
            onChange={(event) => {
              setAcademicYearId(event.target.value);
              setSectionId('');
            }}
            options={(yearsData?.academicYears ?? []).map((year) => ({ value: year.id, label: year.name }))}
            placeholder="Select a year"
          />

          <Select
            label="Class & section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
            options={classSectionsList.map((entry) => ({
              value: entry.sectionId,
              label: `Class ${entry.className} · ${entry.sectionName}`,
            }))}
            placeholder="Select a section"
            disabled={!academicYearId}
          />

          <Select
            label="Subject"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            options={(subjects ?? []).map((subject) => ({
              value: subject.id,
              label: `${subject.code} · ${subject.name}`,
            }))}
            placeholder="Select a subject"
          />

          <Select
            label="Exam"
            value={examId}
            onChange={(event) => setExamId(event.target.value)}
            options={(exams ?? []).map((exam) => ({
              value: exam.id,
              label: `${exam.name} (max ${exam.maxMarks})`,
            }))}
            placeholder="Select an exam"
          />
        </div>

        {!scopeReady && tab !== 'student' && (
          <Alert tone="info" className="mt-3">
            Choose an academic year, section, subject and exam to generate this report.
          </Alert>
        )}
      </Card>

      <Tabs items={items} activeId={tab} onChange={setTab} />

      {can(user, PERMISSIONS.EXPORT_CREATE) && (
        <p className="text-xs text-ink-subtle">
          For very large reports, use the Exports page — it queues the work instead of generating it
          inside the request.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Report shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The header labels a report is titled with, resolved from the selector block.
 *
 * Passed into the loaders rather than re-read there: the ids are what identify the
 * report, and the labels can only ever agree with what the user chose.
 */
interface ReportLabels {
  academicYearName: string;
  sectionName: string;
  subjectName: string;
  subjectCode: string;
  examName: string;
}

/**
 * What the class report table and figures read.
 *
 * Deliberately narrower than the shared `ClassReport`: a class record, a section
 * row and the full grading scheme are not rendered anywhere on this screen, and
 * synthesising them would mean asserting fields this query never read.
 */
interface ClassReportShape {
  academicYear: { name: string };
  subjectIds: string[];
  subjectAverages: Array<{ subjectId: string; subjectName: string; average: number | null }>;
  rows: Array<{
    studentId: string;
    studentNumber: string;
    rollNumber: number | null;
    fullName: string;
    totalObtained: number | null;
    totalMaximum: number;
    percentage: number | null;
    grade: string | null;
    isPass: boolean | null;
    rank: number | null;
  }>;
}

/** As above: the report-card table plus the totals strip beneath it. */
interface StudentReportShape {
  student: {
    id: string;
    fullName: string;
    studentNumber: string;
    className: string;
    sectionName: string;
  };
  academicYear: { name: string };
  rows: Array<{
    subjectId: string;
    examId: string;
    subjectName: string;
    examName: string;
    maxMarks: number;
    marksObtained: number | null;
    status: string;
    percentage: number | null;
    grade: string | null;
    isPass: boolean | null;
    totalObtained: number | null;
    totalMaximum: number;
    overallPercentage: number | null;
    overallGrade: string | null;
    isPassOverall: boolean | null;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Report data                                                                 */
/* -------------------------------------------------------------------------- */

/** One row of `v_marksheet`: a student's mark in one subject for one exam. */
interface MarksRow {
  studentId: string;
  studentNumber: string;
  rollNumber: number | null;
  fullName: string;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  examId: string;
  examName: string;
  marksObtained: number | null;
  maxMarks: number | null;
  percentage: number | null;
  grade: string | null;
  isPass: boolean | null;
  status: string;
}

const MARKS_COLUMNS =
  'student_id, student_number, roll_number, student_name, subject_id, subject_name, subject_code,' +
  ' exam_id, exam_name, marks_obtained, max_marks, percentage, grade, is_pass, status';

/**
 * Every mark in scope, from the one view that already joins it all together.
 *
 * RLS applies to the underlying `marks` table even though the view is queried, so
 * a teacher asking for a section they do not teach gets no rows rather than a
 * permission error — which is why these loaders have nothing to check themselves.
 */
async function readMarks(input: {
  academicYearId: string;
  sectionId?: string;
  subjectId?: string;
  examId?: string;
  studentId?: string;
}): Promise<MarksRow[]> {
  let q = getSupabase()
    .from('v_marksheet')
    .select(MARKS_COLUMNS)
    .eq('academic_year_id', input.academicYearId);

  if (input.sectionId) q = q.eq('section_id', input.sectionId);
  if (input.subjectId) q = q.eq('subject_id', input.subjectId);
  if (input.examId) q = q.eq('exam_id', input.examId);
  if (input.studentId) q = q.eq('student_id', input.studentId);

  const { data, error: failed } = await q.order('roll_number', { ascending: true, nullsFirst: false });
  if (failed) throw toQueryError(failed);

  return camelMany<MarksRow>(data as unknown as Record<string, unknown>[] | null);
}

const PRESENT = 'PRESENT';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toMark(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Averages from the active grading scheme.
 *
 * The scheme is read rather than trusted from the mark rows: a class total is a
 * different number from any single subject's, so its grade has to be banded
 * afresh. A scheme with no matching band yields `null` rather than a guess.
 */
function makeGrader(rules: GradingRule[]) {
  return (percentage: number | null): { grade: string | null; isPass: boolean | null } => {
    if (percentage === null) return { grade: null, isPass: null };
    const rule = rules.find(
      (candidate) => percentage >= Number(candidate.minPercentage) && percentage <= Number(candidate.maxPercentage),
    );
    if (!rule) return { grade: null, isPass: null };
    return { grade: rule.grade, isPass: rule.isPass };
  };
}

/** Subject report: one subject, one exam, every student in the section. */
async function loadSubjectReport(input: {
  academicYearId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
  labels: ReportLabels;
}): Promise<SubjectReportShape> {
  const rows = await readMarks(input);

  const present = rows.filter((row) => row.status === PRESENT);
  const marks = present.map((row) => toMark(row.marksObtained) ?? 0);

  const studentCount = new Set(rows.map((row) => row.studentId)).size;
  const passCount = rows.filter((row) => row.isPass === true).length;
  const failCount = rows.filter((row) => row.isPass === false).length;

  const best = present.reduce<MarksRow | null>(
    (top, row) => (top === null || (toMark(row.marksObtained) ?? 0) > (toMark(top.marksObtained) ?? 0) ? row : top),
    null,
  );
  const worst = present.reduce<MarksRow | null>(
    (low, row) => (low === null || (toMark(row.marksObtained) ?? 0) < (toMark(low.marksObtained) ?? 0) ? row : low),
    null,
  );

  const gradeCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.grade) continue;
    gradeCounts.set(row.grade, (gradeCounts.get(row.grade) ?? 0) + 1);
  }

  return {
    subject: { name: input.labels.subjectName, code: input.labels.subjectCode },
    exam: { name: input.labels.examName },
    section: { name: input.labels.sectionName },
    studentCount,
    presentCount: present.length,
    absentCount: rows.filter((row) => row.status === 'ABSENT').length,
    averageMarks: marks.length ? round2(marks.reduce((a, b) => a + b, 0) / marks.length) : null,
    highestMarks: best ? toMark(best.marksObtained) : null,
    highestStudent: best?.fullName ?? null,
    lowestMarks: worst ? toMark(worst.marksObtained) : null,
    lowestStudent: worst?.fullName ?? null,
    passCount,
    failCount,
    passPercentage: studentCount ? round2((passCount / studentCount) * 100) : 0,
    failPercentage: studentCount ? round2((failCount / studentCount) * 100) : 0,
    gradeDistribution: [...gradeCounts.entries()].map(([grade, count]) => ({
      grade,
      count,
      percentage: studentCount ? round2((count / studentCount) * 100) : 0,
    })),
    rows: rows.map((row) => ({
      studentId: row.studentId,
      studentNumber: row.studentNumber,
      rollNumber: row.rollNumber,
      fullName: row.fullName,
      marksObtained: toMark(row.marksObtained),
      status: row.status,
      percentage: row.percentage === null ? null : Number(row.percentage),
      grade: row.grade,
      isPass: row.isPass,
    })),
  };
}

/**
 * Class report: every subject for one exam, totalled per student and ranked.
 *
 * The percentage is recomputed from the totals rather than averaged from the
 * subject percentages, because averaging would weight a 20-mark paper the same as
 * a 100-mark one. A non-PRESENT row contributes to neither side of the total: an
 * absent student has a mark row but no mark.
 */
async function loadClassReport(input: {
  academicYearId: string;
  sectionId: string;
  examId: string;
  labels: ReportLabels;
}): Promise<ClassReportShape> {
  const [rows, scheme] = await Promise.all([
    readMarks(input),
    getActiveGradingScheme(),
  ]);

  const grade = makeGrader(scheme?.rules ?? []);

  const byStudent = new Map<string, { row: MarksRow; totalObtained: number; totalMaximum: number }>();
  for (const row of rows) {
    const entry = byStudent.get(row.studentId) ?? { row, totalObtained: 0, totalMaximum: 0 };
    if (row.status === PRESENT) {
      entry.totalObtained += toMark(row.marksObtained) ?? 0;
      entry.totalMaximum += toMark(row.maxMarks) ?? 0;
      byStudent.set(row.studentId, entry);
    } else if (!byStudent.has(row.studentId)) {
      byStudent.set(row.studentId, entry);
    }
  }

  const ranked = [...byStudent.values()]
    .map((entry) => {
      const percentage =
        entry.totalMaximum > 0 ? round2((entry.totalObtained / entry.totalMaximum) * 100) : null;
      return { ...entry, percentage, ...grade(percentage) };
    })
    .sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1));

  // Rank is dense over the graded rows only: an absent student has no percentage
  // and therefore no place, rather than a misleading rank at the bottom.
  let place = 0;
  let previous: number | null = null;
  const ranks = new Map<string, number>();
  for (const entry of ranked) {
    if (entry.percentage === null) continue;
    if (previous === null || entry.percentage !== previous) place += 1;
    previous = entry.percentage;
    ranks.set(entry.row.studentId, place);
  }

  const subjectIds: string[] = [];
  const subjectMarks = new Map<string, { name: string; marks: number[] }>();
  for (const row of rows) {
    if (row.status !== PRESENT) continue;
    const entry = subjectMarks.get(row.subjectId) ?? { name: row.subjectName, marks: [] };
    entry.marks.push(toMark(row.marksObtained) ?? 0);
    subjectMarks.set(row.subjectId, entry);
    if (!subjectIds.includes(row.subjectId)) subjectIds.push(row.subjectId);
  }

  return {
    academicYear: { name: input.labels.academicYearName },
    subjectIds,
    subjectAverages: subjectIds.map((id) => {
      const entry = subjectMarks.get(id);
      return {
        subjectId: id,
        subjectName: entry?.name ?? '',
        average: entry && entry.marks.length ? round2(entry.marks.reduce((a, b) => a + b, 0) / entry.marks.length) : null,
      };
    }),
    rows: ranked.map((entry) => ({
      studentId: entry.row.studentId,
      studentNumber: entry.row.studentNumber,
      rollNumber: entry.row.rollNumber,
      fullName: entry.row.fullName,
      totalObtained: entry.totalObtained,
      totalMaximum: entry.totalMaximum,
      percentage: entry.percentage,
      grade: entry.grade,
      isPass: entry.isPass,
      rank: ranks.get(entry.row.studentId) ?? null,
    })),
  };
}

/**
 * Report card: one student across every subject they sat.
 *
 * The overall totals are repeated on every row because the summary strip reads
 * them off the first row, which is how the retired endpoint shaped it too.
 */
async function loadStudentReport(input: {
  academicYearId: string;
  studentId: string;
}): Promise<StudentReportShape> {
  const [rows, student, scheme, years] = await Promise.all([
    readMarks({ academicYearId: input.academicYearId, studentId: input.studentId }),
    getStudent(input.studentId),
    getActiveGradingScheme(),
    listAcademicYears(true),
  ]);

  const grade = makeGrader(scheme?.rules ?? []);

  const present = rows.filter((row) => row.status === PRESENT);
  const totalObtained = present.reduce((total, row) => total + (toMark(row.marksObtained) ?? 0), 0);
  const totalMaximum = present.reduce((total, row) => total + (toMark(row.maxMarks) ?? 0), 0);
  const overallPercentage = totalMaximum > 0 ? round2((totalObtained / totalMaximum) * 100) : null;
  const overall = grade(overallPercentage);

  return {
    student: {
      id: student?.id ?? input.studentId,
      fullName: student?.fullName ?? '',
      studentNumber: student?.studentNumber ?? '',
      className: student?.className ?? '',
      sectionName: student?.sectionName ?? '',
    },
    academicYear: { name: years.find((year) => year.id === input.academicYearId)?.name ?? '' },
    rows: rows.map((row) => ({
      subjectId: row.subjectId,
      examId: row.examId,
      subjectName: row.subjectName,
      examName: row.examName,
      maxMarks: toMark(row.maxMarks) ?? 0,
      marksObtained: toMark(row.marksObtained),
      status: row.status,
      percentage: row.percentage === null ? null : Number(row.percentage),
      grade: row.grade,
      isPass: row.isPass,
      totalObtained,
      totalMaximum,
      overallPercentage,
      overallGrade: overall.grade,
      isPassOverall: overall.isPass,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Printing and downloading                                                    */
/* -------------------------------------------------------------------------- */

type ReportScope = 'subject' | 'class' | 'student';

/** The request body `report-generate` expects, for one scope. */
type PrintableBody = {
  scope: ReportScope;
  academicYearId: string;
  sectionId?: string;
  subjectId?: string;
  studentId?: string;
  examId?: string;
};

/** The body for the active tab, or null when the scope is not fully chosen yet. */
function printableBody(
  tab: string,
  scope: { academicYearId: string; sectionId: string; subjectId: string; examId: string; studentId: string },
): PrintableBody | null {
  if (tab === 'subject') {
    if (!scope.academicYearId || !scope.sectionId || !scope.subjectId || !scope.examId) return null;
    return { scope: 'subject', academicYearId: scope.academicYearId, sectionId: scope.sectionId, subjectId: scope.subjectId, examId: scope.examId };
  }
  if (tab === 'class') {
    if (!scope.academicYearId || !scope.sectionId || !scope.examId) return null;
    return { scope: 'class', academicYearId: scope.academicYearId, sectionId: scope.sectionId, examId: scope.examId };
  }
  if (tab === 'student') {
    if (!scope.academicYearId || !scope.studentId) return null;
    return { scope: 'student', academicYearId: scope.academicYearId, studentId: scope.studentId };
  }
  return null;
}

/** The filename each scope's download is saved under. */
function downloadName(tab: string): string {
  if (tab === 'subject') return 'subject-report';
  if (tab === 'class') return 'class-report';
  return 'report-card';
}

/**
 * Ask `report-generate` for a downloadable file and save it.
 *
 * `downloadViaEdge` is not usable here: it expects a signed `{ url }` back, but
 * `report-generate` answers with the file body itself. A report is rendered on
 * demand and there is nothing worth keeping in a bucket, so storing it would cost
 * a signed URL and a cleanup problem for no benefit. The body is turned into a
 * blob instead, so the filename the user ends up with is the one chosen here
 * rather than a storage path.
 *
 * XLSX arrives base64-encoded, because a workbook is binary and JSON cannot carry
 * it as text.
 */
async function downloadReport(
  body: PrintableBody,
  format: 'csv' | 'xlsx',
  name: string,
): Promise<void> {
  const result = await edgeFetch<{ csv?: string; html?: string; xlsx?: string; filename?: string }>(
    'report-generate',
    { method: 'POST', body: { ...body, format } },
  );

  let blob: Blob | null = null;

  if (typeof result.csv === 'string') {
    blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
  } else if (typeof result.xlsx === 'string') {
    // The function builds the correct extension; trust it over `format`, because
    // a file named `.xlsx` that is not a workbook is one Excel refuses to open.
    blob = new Blob([base64ToArrayBuffer(result.xlsx)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } else if (typeof result.html === 'string') {
    blob = new Blob([result.html], { type: 'text/html;charset=utf-8' });
  }

  if (!blob) throw new QueryError('EMPTY_REPORT', 'The report came back empty.');

  const extension = typeof result.csv === 'string'
    ? 'csv'
    : typeof result.xlsx === 'string'
      ? 'xlsx'
      : 'html';

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${name}.${extension}`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** Decode a base64 workbook into an ArrayBuffer suitable for a Blob. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  // `ArrayBuffer` rather than a typed-array view: TS 5.7 narrowed `ArrayBufferLike`
  // such that a `Uint8Array` over a generic buffer is no longer assignable to
  // `BlobPart`, and copying into a concrete ArrayBuffer is both correct and cheap
  // at these sizes.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return buffer;
}

/* -------------------------------------------------------------------------- */
/* Shared selector data                                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Report views                                                                */
/* -------------------------------------------------------------------------- */

interface SubjectReportShape {
  subject: { name: string; code: string };
  exam: { name: string };
  section: { name: string };
  studentCount: number;
  presentCount: number;
  absentCount: number;
  averageMarks: number | null;
  highestMarks: number | null;
  highestStudent: string | null;
  lowestMarks: number | null;
  lowestStudent: string | null;
  passCount: number;
  failCount: number;
  passPercentage: number;
  failPercentage: number;
  gradeDistribution: Array<{ grade: string; count: number; percentage: number }>;
  rows: Array<{
    studentId: string;
    studentNumber: string;
    rollNumber: number | null;
    fullName: string;
    marksObtained: number | null;
    status: string;
    percentage: number | null;
    grade: string | null;
    isPass: boolean | null;
  }>;
}

function SubjectReportView({
  report,
  loading,
  error,
}: {
  report?: SubjectReportShape;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <LoadingState label="Building the subject report…" />;
  if (error) return <ErrorState message={error} />;
  if (!report) return <EmptyState title="Choose a section, subject and exam" icon={<IconChart size={18} />} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Average" value={formatMark(report.averageMarks)} />
        <StatTile
          label="Highest"
          value={formatMark(report.highestMarks)}
          hint={report.highestStudent ?? undefined}
          tone="success"
        />
        <StatTile
          label="Lowest"
          value={formatMark(report.lowestMarks)}
          hint={report.lowestStudent ?? undefined}
        />
        <StatTile
          label="Pass rate"
          value={formatPercent(report.passPercentage, 0)}
          hint={`${report.passCount} pass · ${report.failCount} fail`}
          tone={report.passPercentage >= 50 ? 'success' : 'danger'}
        />
      </div>

      <Card>
        <CardHeader title="Grade distribution" />
        <SubjectAverageChart
          data={report.gradeDistribution.map((entry) => ({ subjectName: entry.grade, average: entry.count }))}
        />
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Student results"
            description={`${report.presentCount} present · ${report.absentCount} absent of ${pluralise(report.studentCount, 'student', 'students')}`}
          />
        </div>
        <Table caption="Subject results">
          <THead>
            <tr>
              <TH numeric>Roll</TH>
              <TH>Student</TH>
              <TH numeric>Marks</TH>
              <TH numeric>%</TH>
              <TH>Grade</TH>
              <TH>Result</TH>
            </tr>
          </THead>
          <TBody>
            {report.rows.map((row) => (
              <TR key={row.studentId}>
                <TD numeric className="tabular text-ink-muted">{row.rollNumber ?? '—'}</TD>
                <TD>
                  <p className="font-medium text-ink">{row.fullName}</p>
                  <p className="tabular text-xs text-ink-subtle">{row.studentNumber}</p>
                </TD>
                <TD numeric className="tabular">
                  {row.status === 'PRESENT' ? (
                    <span className="text-ink">{formatMark(row.marksObtained)}</span>
                  ) : (
                    <Badge tone="neutral">{row.status}</Badge>
                  )}
                </TD>
                <TD numeric className="tabular text-ink">{formatPercent(row.percentage)}</TD>
                <TD className="tabular font-medium text-ink">{row.grade ?? '—'}</TD>
                <TD>
                  {row.isPass === null ? (
                    '—'
                  ) : row.isPass ? (
                    <Badge tone="success">Pass</Badge>
                  ) : (
                    <Badge tone="danger">Fail</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function ClassReportView({
  report,
  loading,
  error,
}: {
  report?: ClassReportShape;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <LoadingState label="Building the class report…" />;
  if (error) return <ErrorState message={error} />;
  if (!report) return <EmptyState title="Choose a section and exam" icon={<IconChart size={18} />} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Students" value={report.rows.length} />
        <StatTile label="Subjects" value={report.subjectIds.length} />
        <StatTile
          label="Academic year"
          value={report.academicYear.name}
        />
      </div>

      <Card>
        <CardHeader title="Subject averages" />
        <SubjectAverageChart data={report.subjectAverages} />
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader title="All results" description="Ranked by percentage." />
        </div>
        <Table caption="Class results">
          <THead>
            <tr>
              <TH numeric>Rank</TH>
              <TH numeric>Roll</TH>
              <TH>Student</TH>
              <TH numeric>Total</TH>
              <TH numeric>%</TH>
              <TH>Grade</TH>
              <TH>Result</TH>
            </tr>
          </THead>
          <TBody>
            {report.rows.map((row) => (
              <TR key={row.studentId}>
                <TD numeric className="tabular text-ink-muted">{row.rank ?? '—'}</TD>
                <TD numeric className="tabular text-ink-muted">{row.rollNumber ?? '—'}</TD>
                <TD>
                  <p className="font-medium text-ink">{row.fullName}</p>
                  <p className="tabular text-xs text-ink-subtle">{row.studentNumber}</p>
                </TD>
                <TD numeric className="tabular text-ink">
                  {formatMark(row.totalObtained)} / {formatMark(row.totalMaximum)}
                </TD>
                <TD numeric className="tabular text-ink">{formatPercent(row.percentage)}</TD>
                <TD className="tabular font-medium text-ink">{row.grade ?? '—'}</TD>
                <TD>
                  {row.isPass === null ? (
                    '—'
                  ) : row.isPass ? (
                    <Badge tone="success">Pass</Badge>
                  ) : (
                    <Badge tone="danger">Fail</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function StudentReportView({
  report,
  loading,
  error,
  selectedStudentId,
  onSelectStudent,
  search,
  onSearch,
  results,
}: {
  report?: StudentReportShape;
  loading: boolean;
  error: string | null;
  selectedStudentId: string;
  onSelectStudent: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  results: Array<{ id: string; fullName: string; studentNumber: string; className?: string; sectionName?: string }>;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Find a student" />
        <label htmlFor="report-student-search" className="block text-sm font-medium text-ink">
          Search by name or student ID
        </label>
        <input
          id="report-student-search"
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Start typing a name…"
          className="mt-1.5 h-10 w-full rounded-lg border border-line-strong px-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />

        {search.trim().length >= 2 && (
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto scrollbar-thin">
            {results.length === 0 && (
              <li className="px-2 py-3 text-sm text-ink-subtle">No students matched.</li>
            )}
            {results.map((student) => (
              <li key={student.id}>
                <button
                  type="button"
                  onClick={() => onSelectStudent(student.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedStudentId === student.id
                      ? 'border-brand-500 bg-brand-50'
                      : 'border-line hover:bg-surface-muted'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {student.fullName}
                    </span>
                    <span className="tabular block truncate text-xs text-ink-subtle">
                      {student.studentNumber}
                      {student.className && ` · ${student.className}-${student.sectionName}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {loading && <LoadingState label="Loading the report card…" />}
      {error && <ErrorState message={error} />}
      {!loading && !error && !report && (
        <EmptyState title="Select a student to see their report card" icon={<IconFile size={18} />} />
      )}

      {report && (
        <Card flush>
          <div className="p-5 pb-0">
            <CardHeader
              title={report.student.fullName}
              description={`${report.student.studentNumber} · Class ${report.student.className}-${report.student.sectionName} · ${report.academicYear.name}`}
            />
          </div>

          <Table caption="Student report card">
            <THead>
              <tr>
                <TH>Subject</TH>
                <TH>Exam</TH>
                <TH numeric>Max</TH>
                <TH numeric>Marks</TH>
                <TH numeric>%</TH>
                <TH>Grade</TH>
                <TH>Result</TH>
              </tr>
            </THead>
            <TBody>
              {report.rows.map((row) => (
                <TR key={`${row.subjectId}-${row.examId}`}>
                  <TD className="font-medium text-ink">{row.subjectName}</TD>
                  <TD className="text-ink-muted">{row.examName}</TD>
                  <TD numeric className="tabular text-ink-muted">{formatMark(row.maxMarks)}</TD>
                  <TD numeric className="tabular">
                    {row.status === 'PRESENT' ? (
                      <span className="text-ink">{formatMark(row.marksObtained)}</span>
                    ) : (
                      <Badge tone="neutral">{row.status}</Badge>
                    )}
                  </TD>
                  <TD numeric className="tabular text-ink">{formatPercent(row.percentage)}</TD>
                  <TD className="tabular font-medium text-ink">{row.grade ?? '—'}</TD>
                  <TD>
                    {row.isPass === null ? (
                      '—'
                    ) : row.isPass ? (
                      <Badge tone="success">Pass</Badge>
                    ) : (
                      <Badge tone="danger">Fail</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          {report.rows.length > 0 && (
            <div className="border-t border-line p-5">
              <div className="flex flex-wrap items-center gap-6">
                <Summary label="Total" value={`${formatMark(report.rows[0]?.totalObtained ?? 0)} / ${formatMark(report.rows[0]?.totalMaximum ?? 0)}`} />
                <Summary label="Percentage" value={formatPercent(report.rows[0]?.overallPercentage ?? null)} />
                <Summary label="Grade" value={report.rows[0]?.overallGrade ?? '—'} />
                <Summary
                  label="Result"
                  value={
                    report.rows[0]?.isPassOverall === null || report.rows[0]?.isPassOverall === undefined
                      ? 'Not graded'
                      : report.rows[0]?.isPassOverall
                        ? 'PASS'
                        : 'FAIL'
                  }
                  tone={report.rows[0]?.isPassOverall ? 'success' : 'danger'}
                />
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger';
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-semibold ${
          tone === 'success' ? 'text-success-700' : tone === 'danger' ? 'text-danger-700' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
