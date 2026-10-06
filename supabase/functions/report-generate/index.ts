import { hasPermission, requireCaller, isAssignedTo } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Build a subject, class or student report.
 *
 * Port of the three `/api/reports/*` routes and their HTML renderers.
 *
 * One function with a `scope` rather than three, because they share the shape:
 * a header, a table of students with per-subject marks, and totals. The retired
 * Worker had three near-duplicate route handlers and three near-duplicate
 * renderers; consolidating them removes the chance that a fix to one is not
 * applied to the others.
 *
 * ── "PDF" means HTML ─────────────────────────────────────────────────────────
 * As it always has in this app. `format: 'pdf'` returns print-ready HTML and the
 * browser's print dialog produces the PDF. A real PDF library would need font
 * embedding and pagination logic that nothing asked for.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * `report:view_all` sees everything. Otherwise the caller's section assignment is
 * checked for class and subject reports, and a student report is allowed only
 * when the student is in a section the caller teaches. This mirrors the retired
 * `assertStudentReadable()`, whose student bypasses (`report:view_all`,
 * `student:create`) are preserved.
 */

interface ReportRow {
  studentId: string;
  studentNumber: string;
  rollNumber: number | null;
  fullName: string;
  marksObtained: number | null;
  maxMarks: number | null;
  percentage: number | null;
  grade: string | null;
  gradePoint: number | null;
  isPass: boolean | null;
  status: string;
  absent: boolean;
  exempted: boolean;
  medical: boolean;
  subjectName?: string;
  examName?: string;
  subjectCode?: string;
}

/**
 * The school's own identity, as stored in `settings`.
 *
 * Read from the database rather than compiled in, so an administrator who
 * corrects their affiliation number on the Settings screen gets it corrected on
 * every sheet they print, with no redeploy. See migration 0017.
 */
interface SchoolIdentity {
  name: string;
  shortName: string;
  location: string;
  authority: string;
  affiliation: string;
  phone: string;
  email: string;
  website: string;
}

interface ReportPayload {
  scope: 'subject' | 'class' | 'student';
  title: string;
  subtitle: string;
  school: SchoolIdentity;
  academicYear: string;
  sectionId?: string;
  sectionName?: string;
  className?: string;
  subjectId?: string;
  subjectName?: string;
  examId?: string;
  examName?: string;
  maxMarks: number | null;
  weightage: number;
  rows: ReportRow[];
  totals: {
    students: number;
    entered: number;
    averagePercentage: number | null;
    highestPercentage: number | null;
    lowestPercentage: number | null;
    passCount: number;
    failCount: number;
    absentCount: number;
  };
  gradeDistribution: Array<{ grade: string; count: number }>;
  generatedAt: string;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'report:view_assigned'))) {
        return fail('FORBIDDEN', 'You do not have permission to view reports.', 403);
      }

      const body = await readJson<{
        scope?: string;
        format?: string;
        academicYearId?: string;
        sectionId?: string;
        subjectId?: string;
        studentId?: string;
        examId?: string;
      }>(request);

      const scope = body.scope ?? 'class';
      const academicYearId = body.academicYearId;

      if (!academicYearId) {
        return fail('VALIDATION_ERROR', 'An academic year is required.', 400);
      }

      if (!['subject', 'class', 'student'].includes(scope)) {
        return fail('VALIDATION_ERROR', `"${scope}" is not a report scope.`, 400);
      }

      const seesEverything =
        (await hasPermission(caller, 'report:view_all')) ||
        (await hasPermission(caller, 'student:create'));

      const payload = await buildReport(caller, {
        scope: scope as ReportPayload['scope'],
        academicYearId,
        sectionId: body.sectionId,
        subjectId: body.subjectId,
        studentId: body.studentId,
        examId: body.examId,
        seesEverything,
      });

      if (!payload) {
        return fail('VALIDATION_ERROR', 'That report needs a section, subject or student.', 400);
      }

      // Authorisation, after the report is resolved: this is what lets a student
      // report be checked against the section the student is actually in.
      if (!seesEverything) {
        if (!payload.sectionId) {
          return fail('FORBIDDEN', 'You can only view reports for classes you teach.', 403);
        }

        // A subject report is scoped to one subject; a class report covers every
        // subject taught, so it needs at least one assignment in the section.
        const allowed = payload.subjectId
          ? await isAssignedTo(caller, {
              sectionId: payload.sectionId,
              subjectId: payload.subjectId,
              academicYearId,
            })
          : (await assignmentsInSection(caller, payload.sectionId, academicYearId)) > 0;

        if (!allowed) {
          return fail(
            'FORBIDDEN',
            'You are not assigned to this class, so this report is not available to you.',
            403,
          );
        }
      }

      if (payload.rows.length === 0) {
        return fail('NOT_FOUND', 'There are no marks for this report yet.', 404);
      }

      // CSV is generated directly. "pdf" is HTML plus the browser's print dialog.
      if (body.format === 'csv') {
        return json({ filename: filenameFor(payload, 'csv'), csv: toCsv(payload.rows) });
      }

      if (body.format === 'json') {
        return json(payload);
      }

      // XLSX is a real workbook, not an HTML table under the wrong extension.
      if (body.format === 'xlsx') {
        const { buildWorkbook } = await import('../_shared/xlsx.ts');

        const workbook = buildWorkbook(payload.rows.map(toExportRow), payload.title);

        return json({
          filename: filenameFor(payload, 'xlsx'),
          xlsx: bytesToBase64(workbook),
        });
      }

      const html = renderReportHtml(payload, body.format === 'pdf');

      return json({
        html,
        filename: filenameFor(payload),
        autoPrint: body.format === 'pdf',
      });
    }),
);

/* -------------------------------------------------------------------------- */
/* Report assembly                                                              */
/* -------------------------------------------------------------------------- */

type Caller = Awaited<ReturnType<typeof requireCaller>>;

async function buildReport(
  caller: Caller,
  input: {
    scope: ReportPayload['scope'];
    academicYearId: string;
    sectionId?: string;
    subjectId?: string;
    studentId?: string;
    examId?: string;
    seesEverything: boolean;
  },
): Promise<ReportPayload | null> {
  const { scope, academicYearId } = input;

  // A student report needs only the student; resolve their section from it.
  let sectionId = input.sectionId;
  let studentFilter: string | null = null;

  if (scope === 'student') {
    if (!input.studentId) return null;

    const { data } = await caller.supabase
      .from('v_students')
      .select('id, section_id, class_id')
      .eq('id', input.studentId)
      .maybeSingle();

    const student = data as { id: string; section_id: string; class_id: string } | null;
    if (!student) return null;

    sectionId = student.section_id;
    studentFilter = student.id;
  }

  if (!sectionId) return null;

  const [sectionRes, settingsRes] = await Promise.all([
    caller.supabase
      .from('v_class_sections')
      .select('class_id, class_name, section_name, academic_year_name')
      .eq('section_id', sectionId)
      .eq('academic_year_id', academicYearId)
      .maybeSingle(),
    caller.supabase.from('settings').select('key, value'),
  ]);

  const section = sectionRes.data as
    | { class_id: string; class_name: string; section_name: string; academic_year_name: string }
    | null;

  if (!section) return null;

  const settings: Record<string, string> = {};
  for (const row of (settingsRes.data ?? []) as Array<{ key: string; value: string }>) {
    settings[row.key] = row.value;
  }

  let q = caller.supabase
    .from('v_marksheet')
    .select('student_id, student_number, roll_number, student_name, subject_id, subject_code, subject_name, exam_id, exam_name, marks_obtained, max_marks, percentage, grade, grade_point, is_pass, status');

  q = q.eq('academic_year_id', academicYearId).eq('section_id', sectionId);

  if (scope === 'subject') {
    if (!input.subjectId) return null;
    q = q.eq('subject_id', input.subjectId);
  }

  if (input.examId) q = q.eq('exam_id', input.examId);
  if (studentFilter) q = q.eq('student_id', studentFilter);

  const { data, error } = await q.order('roll_number', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`marksheet query failed: ${error.message}`);

  const raw = data ?? [];

  let subjectName: string | undefined;
  let subjectCode: string | undefined;
  let examName: string | undefined;
  let maxMarks: number | null = null;
  let weightage = 1;

  if (scope === 'subject' && input.subjectId) {
    const { data: subject } = await caller.supabase
      .from('subjects')
      .select('name, code')
      .eq('id', input.subjectId)
      .maybeSingle();

    const found = subject as { name?: string; code?: string } | null;
    subjectName = found?.name;
    subjectCode = found?.code;
  }

  if (input.examId) {
    const { data: exam } = await caller.supabase
      .from('exams')
      .select('name, max_marks, weightage')
      .eq('id', input.examId)
      .maybeSingle();

    const found = exam as { name?: string; max_marks?: number; weightage?: number } | null;
    examName = found?.name;
    maxMarks = found?.max_marks ?? null;
    weightage = found?.weightage ?? 1;
  } else if (scope === 'subject') {
    const first = raw[0] as { max_marks?: number } | undefined;
    maxMarks = first?.max_marks ?? null;
    examName = (raw[0] as { exam_name?: string } | undefined)?.exam_name;
  }

  // One row per student. A class report spans subjects, so several mark rows can
  // belong to the same student and are totalled here rather than producing
  // duplicate lines.
  const byStudent = new Map<string, ReportRow>();

  for (const row of raw as Array<Record<string, unknown>>) {
    const id = row.student_id as string;
    const status = (row.status as string) ?? 'PRESENT';
    const obtained = toNumber(row.marks_obtained);
    const max = toNumber(row.max_marks);

    const existing = byStudent.get(id);

    if (existing) {
      // A non-numeric status contributes no mark to the total, but must still be
      // counted so the header shows the right absent/exempted tallies.
      if (status !== 'PRESENT') {
        if (status === 'ABSENT') existing.absent = true;
        if (status === 'EXEMPTED') existing.exempted = true;
        if (status === 'MEDICAL') existing.medical = true;
      } else {
        existing.marksObtained = (existing.marksObtained ?? 0) + obtained;
        existing.maxMarks = (existing.maxMarks ?? 0) + max;
      }
      continue;
    }

    byStudent.set(id, {
      studentId: id,
      studentNumber: (row.student_number as string) ?? '',
      rollNumber: row.roll_number === null ? null : Number(row.roll_number),
      fullName: (row.student_name as string) ?? '',
      marksObtained: status === 'PRESENT' ? obtained : 0,
      maxMarks: status === 'PRESENT' ? max : 0,
      percentage: row.percentage === null ? null : Number(row.percentage),
      grade: (row.grade as string) ?? null,
      gradePoint: row.grade_point === null ? null : Number(row.grade_point),
      isPass: typeof row.is_pass === 'boolean' ? row.is_pass : null,
      status,
      absent: status === 'ABSENT',
      exempted: status === 'EXEMPTED',
      medical: status === 'MEDICAL',
      subjectName: row.subject_name as string | undefined,
      examName: row.exam_name as string | undefined,
      subjectCode: row.subject_code as string | undefined,
    });
  }

  const rows = [...byStudent.values()];

  // Recompute the class-level percentage from totals, because averaging
  // per-subject percentages would weight a 20-mark paper like a 100-mark one.
  for (const row of rows) {
    if ((row.maxMarks ?? 0) > 0) {
      row.percentage = Math.round(((row.marksObtained ?? 0) / row.maxMarks!) * 100 * 100) / 100;
    } else if (row.absent || row.exempted || row.medical) {
      row.percentage = null;
    }

    if (row.percentage === null && !row.absent) {
      row.percentage = row.marksObtained === 0 && row.maxMarks === 0 ? 0 : row.percentage;
    }
  }

  const graded = rows.filter((r) => r.percentage !== null);
  const percentages = graded.map((r) => r.percentage as number);

  const distribution = new Map<string, number>();
  for (const row of rows) {
    if (!row.grade) continue;
    distribution.set(row.grade, (distribution.get(row.grade) ?? 0) + 1);
  }

  const title =
    scope === 'student'
      ? rows[0]?.fullName ?? 'Student report'
      : scope === 'subject'
        ? `${subjectName ?? 'Subject'} — ${section.class_name} ${section.section_name}`
        : `${section.class_name} ${section.section_name}`;

  const subtitle =
    scope === 'student'
      ? `${section.academic_year_name}${examName ? ` · ${examName}` : ''}`
      : scope === 'subject'
        ? `${section.academic_year_name}${examName ? ` · ${examName}` : ''}`
        : `${section.academic_year_name}`;

  return {
    scope,
    title,
    subtitle,
    school: {
      // `school.name` is the one key with a row in every deployment, so it is
      // the only one with a meaningful fallback; a blank crest on a mark sheet
      // would be worse than a generic one.
      name: settings['school.name'] || 'Christ Church Co-Ed School',
      shortName: settings['school.short_name'] || 'Christ Church Co-Ed',
      location: settings['school.location'] || '',
      authority: settings['school.authority'] || '',
      affiliation: settings['school.affiliation'] || '',
      phone: settings['school.phone'] || '',
      email: settings['school.email'] || '',
      website: settings['school.website'] || '',
    },
    academicYear: section.academic_year_name,
    sectionId,
    sectionName: section.section_name,
    className: section.class_name,
    subjectId: input.subjectId,
    subjectName,
    examId: input.examId,
    examName,
    maxMarks,
    weightage,
    rows,
    totals: {
      students: rows.length,
      entered: graded.length,
      averagePercentage:
        percentages.length > 0
          ? Math.round((percentages.reduce((a, b) => a + b, 0) / percentages.length) * 100) / 100
          : null,
      highestPercentage: percentages.length > 0 ? Math.max(...percentages) : null,
      lowestPercentage: percentages.length > 0 ? Math.min(...percentages) : null,
      passCount: rows.filter((r) => r.isPass === true).length,
      failCount: rows.filter((r) => r.isPass === false).length,
      absentCount: rows.filter((r) => r.absent).length,
    },
    gradeDistribution: [...distribution.entries()]
      .map(([grade, count]) => ({ grade, count }))
      .sort((a, b) => a.grade.localeCompare(b.grade)),
    generatedAt: new Date().toISOString(),
  };
}

async function assignmentsInSection(
  caller: Caller,
  sectionId: string,
  academicYearId: string,
): Promise<number> {
  const { count } = await caller.supabase
    .from('teacher_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('section_id', sectionId)
    .eq('academic_year_id', academicYearId)
    .eq('teacher_id', caller.clerkUserId);

  return count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                    */
/* -------------------------------------------------------------------------- */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function formatMark(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function statusBadge(row: ReportRow): string {
  if (row.absent) return '<span class="badge badge-absent">Absent</span>';
  if (row.exempted) return '<span class="badge badge-exempted">Exempted</span>';
  if (row.medical) return '<span class="badge badge-medical">Medical</span>';
  if (row.percentage === null) return '<span class="badge badge-none">Not marked</span>';
  return '';
}

function renderReportHtml(report: ReportPayload, autoPrint: boolean): string {
  const head = report.scope === 'subject'
    ? ['Roll', 'Student #', 'Name', 'Marks', `/${report.maxMarks ?? ''}`, '%', 'Grade']
    : ['Roll', 'Student #', 'Name', 'Obtained', 'Possible', '%', 'Grade', 'Result'];

  const body = report.rows
    .map((row) => {
      const cells = [
        row.rollNumber ?? '',
        escapeHtml(row.studentNumber),
        escapeHtml(row.fullName),
        formatMark(row.marksObtained),
        formatMark(row.maxMarks),
        row.percentage === null ? '—' : `${row.percentage}%`,
        row.grade ?? '—',
      ];

      if (report.scope === 'subject') {
        cells.splice(5, 0, statusBadge(row));
      } else {
        cells.push(
          row.isPass === null ? '—' : row.isPass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>',
        );
      }

      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');

  const t = report.totals;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(report.school.name)} — ${escapeHtml(report.title)}</title>
<style>
  @page { margin: 14mm; size: A4; }
  * { box-sizing: border-box; }

  /*
   * The palette is the application's own, written out longhand because this
   * document is rendered in a detached window that loads no stylesheet and no
   * webfont. It is the school's slate-teal (#43616f) and sage (#5d7772) on a
   * warm paper ground — the same tokens as the screen, so a printed sheet and
   * the screen it was generated from read as one system.
   */
  body {
    font: 11px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #1a1813;
    margin: 0;
    padding: 16px;
  }

  /* ── Letterhead ───────────────────────────────────────────────────────────
     A CBSE institution's mark sheet is expected to carry the school name, its
     address and its affiliation number. The old header printed the name in a
     small uppercase line above the title and nothing else, which is not a
     document any school would put its name to. */
  header {
    border-bottom: 2px solid #43616f;
    padding-bottom: 10px;
    margin-bottom: 14px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
  }
  .letterhead { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
  .letterhead .name {
    font: 700 17px/1.2 'Lato', ui-sans-serif, system-ui, sans-serif;
    margin: 0;
  }
  .letterhead .loc { font-size: 10px; color: #57534e; margin: 2px 0 0; }
  .letterhead .affil {
    font-size: 9px; color: #57534e; margin: 2px 0 0;
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  }
  .right { text-align: right; font-size: 9px; line-height: 1.5; color: #57534e; flex-shrink: 0; }
  .right .title {
    font: 700 15px/1.2 'Lato', ui-sans-serif, system-ui, sans-serif;
    color: #1a1813; margin: 0 0 2px;
  }
  .meta { margin: 0; font-size: 10px; color: #57534e; }

  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; }
  th { background: #43616f; color: #fff; font-weight: 600; }
  tbody tr:nth-child(even) { background: #faf8f4; }
  tr { page-break-inside: avoid; }
  .pass { color: #047857; font-weight: 600; }
  .fail { color: #b91c1c; font-weight: 600; }
  .badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; font-weight: 600; }
  .badge-absent { background: #fee2e2; color: #991b1b; }
  .badge-exempted { background: #fef3c7; color: #92400e; }
  .badge-medical { background: #dbeafe; color: #1e40af; }
  .badge-none { background: #f1f5f9; color: #475569; }
  .summary { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; margin-bottom: 10px; }
  .summary b { font-weight: 600; }
  .dist { font-size: 11px; color: #57534e; }

  /* Signature blocks. A mark sheet without somewhere to sign is not a record. */
  .signoff { display: flex; justify-content: space-between; gap: 24px; margin-top: 26px; }
  .signoff div { flex: 1; font-size: 10px; color: #57534e; }
  .signoff .rule { border-top: 1px solid #78716c; margin-bottom: 3px; }

  footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e7e5e4; font-size: 10px; color: #78716c; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style>
</head>
<body>
<header>
  <div class="letterhead">
    ${crestSvg(report.school.name)}
    <div>
      <p class="name">${escapeHtml(report.school.name)}</p>
      ${report.school.location ? `<p class="loc">${escapeHtml(report.school.location)}</p>` : ''}
      ${report.school.affiliation ? `<p class="affil">${escapeHtml(report.school.affiliation)}</p>` : ''}
    </div>
  </div>

  <div class="right">
    <p class="title">${escapeHtml(report.title)}</p>
    <p class="meta">
      ${escapeHtml(report.subtitle)}
      ${report.weightage !== 1 ? ` · weightage ${report.weightage}` : ''}
    </p>
    ${report.school.authority ? `<div>${escapeHtml(report.school.authority)}</div>` : ''}
    ${report.school.phone ? `<div>${escapeHtml(report.school.phone)}</div>` : ''}
  </div>
</header>

<div class="summary">
  <span><b>${t.students}</b> students</span>
  <span><b>${t.entered}</b> marked</span>
  <span>Average <b>${t.averagePercentage === null ? '—' : `${t.averagePercentage}%`}</b></span>
  <span>Highest <b>${t.highestPercentage === null ? '—' : `${t.highestPercentage}%`}</b></span>
  <span>Lowest <b>${t.lowestPercentage === null ? '—' : `${t.lowestPercentage}%`}</b></span>
  <span><b>${t.passCount}</b> passed</span>
  <span><b>${t.failCount}</b> failed</span>
  <span><b>${t.absentCount}</b> absent</span>
</div>

${
  report.gradeDistribution.length > 0
    ? `<p class="dist">Grades: ${report.gradeDistribution
        .map((d) => `${escapeHtml(d.grade)} × ${d.count}`)
        .join(' · ')}</p>`
    : ''
}

<table>
  <thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
  <tbody>${body}</tbody>
</table>

<div class="signoff">
  <div><div class="rule"></div>Class teacher</div>
  <div><div class="rule"></div>Exam cell</div>
  <div><div class="rule"></div>Principal</div>
</div>

<footer>
  Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}.
  Marks are confidential records.
  ${report.school.website ? ` · ${escapeHtml(report.school.website.replace(/^https?:\/\//, ''))}` : ''}
</footer>
${autoPrint ? '<script>window.setTimeout(function(){window.print()},350)</script>' : ''}
</body>
</html>`;
}

/**
 * The crest, as inline SVG.
 *
 * Inline rather than an `<img src>` because this document is written into a
 * detached window via `document.write` and printed — an external image would be
 * a second request that can fail, and a broken-image icon in the corner of a
 * school's letterhead is worse than no crest at all. Inline SVG cannot fail to
 * load and cannot 404.
 *
 * Geometry matches `components/ui/Crest.tsx`: a sage shield ringed in the brand
 * slate-teal, carrying a monogram. It is the same mark the sidebar shows, drawn
 * by the same proportions, so screen and paper agree.
 *
 * ── No webfont ───────────────────────────────────────────────────────────────
 *
 * The monogram is deliberately rendered in the generic serif stack rather than
 * Lato. This document must print identically whether or not a font request
 * succeeded, and a webfont that arrives after `window.print()` has fired prints
 * as a fallback anyway. The letterhead's *name* is set in Lato with a system
 * fallback, so a slow font degrades to the system sans rather than to nothing.
 */
function crestSvg(schoolName: string): string {
  return `<svg class="crest" width="44" height="44" viewBox="0 0 48 48" role="img" aria-label="${escapeHtml(schoolName)} crest">
  <path d="M24 2.5 5.5 8.5v15.2c0 9.5 7.4 17.9 18.5 21.8 11.1-3.9 18.5-12.3 18.5-21.8V8.5Z" fill="#5d7772"/>
  <path d="M24 2.5 5.5 8.5v15.2c0 9.5 7.4 17.9 18.5 21.8 11.1-3.9 18.5-12.3 18.5-21.8V8.5Z" fill="none" stroke="#43616f" stroke-width="2.5"/>
  <text x="24" y="24" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="Georgia, 'Times New Roman', serif" font-size="17" font-weight="700">${escapeHtml(monogramOf(schoolName))}</text>
</svg>`;
}

/**
 * Two-letter monogram, derived from the school name.
 *
 * Mirrors `monogramOf()` in `frontend/src/lib/school.ts`. Derived rather than
 * hardcoded so that an administrator renaming the school in Settings cannot
 * leave a stale "CC" printed on a mark sheet.
 */
function monogramOf(name: string): string {
  const words = name
    .split(/[\s-]+/)
    .map((word) => word.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean);

  if (words.length === 0) return 'S';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function toCsv(rows: ReportRow[]): string {
  const headers = [
    'roll_number', 'student_number', 'full_name', 'marks_obtained', 'max_marks',
    'percentage', 'grade', 'status',
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    const status = row.absent ? 'ABSENT' : row.exempted ? 'EXEMPTED' : row.medical ? 'MEDICAL' : row.percentage === null ? 'NOT_MARKED' : 'PRESENT';

    lines.push(
      [
        row.rollNumber ?? '',
        row.studentNumber,
        row.fullName,
        row.marksObtained ?? '',
        row.maxMarks ?? '',
        row.percentage ?? '',
        row.grade ?? '',
        status,
      ]
        .map((cell) => (/[",\r\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell)))
        .join(','),
    );
  }

  return lines.join('\r\n');
}

function filenameFor(report: ReportPayload, format?: string): string {
  const scope = report.scope === 'student' ? 'student' : report.subjectName ? 'subject' : 'class';
  const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const extension = format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'csv' : 'html';
  return `${scope}-${slug}-${report.academicYear}.${extension}`;
}

/** A report row flattened for the workbook writer. */
function toExportRow(row: ReportRow): Record<string, unknown> {
  return {
    roll_number: row.rollNumber ?? '',
    student_number: row.studentNumber,
    full_name: row.fullName,
    marks_obtained: row.marksObtained ?? '',
    max_marks: row.maxMarks ?? '',
    percentage: row.percentage === null ? '' : row.percentage,
    grade: row.grade ?? '',
    status: row.absent
      ? 'ABSENT'
      : row.exempted
        ? 'EXEMPTED'
        : row.medical
          ? 'MEDICAL'
          : row.percentage === null
            ? 'NOT_MARKED'
            : 'PRESENT',
    result: row.isPass === null ? '' : row.isPass ? 'PASS' : 'FAIL',
  };
}

/** Base64 without pulling in a dependency; chunked to stay off the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}