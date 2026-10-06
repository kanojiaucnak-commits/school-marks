import { audit, enforceRateLimit, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';
import { buildExportPath } from '../_shared/upload.ts';
import { toCsv } from '../_shared/csv.ts';

/**
 * Generate an export and store it in a private Storage bucket.
 *
 * Port of `exportService.requestExportJob()` / `runExportJob()`.
 *
 * —— Everything runs inline, on purpose ————————————————————————————————————————
 *
 * The Cloudflare Worker this was ported from had a tight CPU ceiling, so anything
 * over `SYNC_ROW_LIMIT` rows was marked `QUEUED` for a queue consumer to pick up.
 * That consumer died with the Worker and has no Supabase equivalent wired up, so
 * the branch was pure data loss: the job sat in `QUEUED` forever, the UI said "it
 * will appear in your exports shortly", and nothing ever ran.
 *
 * It was also unnecessary. Edge Functions have a far higher ceiling than the Worker
 * did, and by the time the old branch triggered the rows had *already* been
 * fetched — only the render and upload were being skipped. Rendering a few thousand
 * rows of CSV or XLSX is milliseconds of work.
 *
 * So there is one code path now. `MAX_ROWS` remains, but as an honest guard: past
 * it the request is refused with an explanation rather than accepted and dropped.
 *
 * "PDF" here is still HTML plus the browser's print dialog — the retired Worker did
 * the same thing and named the files `*.html`. That behaviour is preserved rather
 * than quietly replaced with a PDF library nobody asked for.
 */

/**
 * Upper bound on a single export.
 *
 * No longer a CPU threshold — it bounds memory, since the whole dataset is held in
 * memory to be rendered. Generous for any real school, and a refusal above it is
 * visible rather than silent.
 */
const MAX_ROWS = 50_000;
const BUCKET = 'generated-reports';

type Format = 'csv' | 'xlsx' | 'json' | 'pdf';

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      const canExport =
        (await hasPermission(caller, 'export:create')) ||
        (await hasPermission(caller, 'student:export'));

      if (!canExport) {
        return fail('FORBIDDEN', 'You do not have permission to export data.', 403);
      }

      // Generation is CPU-bound and writes to storage, so it is the most expensive
      // action a user can trigger repeatedly.
      await enforceRateLimit(caller, 'exportGenerate');

      const body = await readJson<{
        kind?: string;
        format?: string;
        params?: Record<string, unknown>;
      }>(request);

      const kind = body.kind ?? 'students';
      const format = (body.format ?? 'csv').toLowerCase() as Format;

      if (!['csv', 'xlsx', 'json', 'pdf'].includes(format)) {
        return fail('VALIDATION_ERROR', `"${format}" is not a supported export format.`, 400);
      }

      // Record the job first, so an interrupted generation is still visible and
      // can be retried by an administrator rather than vanishing.
      const { data: job, error: jobError } = await caller.supabase
        .from('export_jobs')
        .insert({
          requested_by: caller.clerkUserId,
          kind,
          format,
          params: body.params ?? null,
          status: 'RUNNING',
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (jobError) {
        console.error('export_jobs insert failed', jobError);
        return fail('INTERNAL_ERROR', 'The export could not be started.', 500);
      }

      try {
        const { rows, filename } = await buildDataset(caller, kind, body.params ?? {});
        const extension = format === 'pdf' ? 'html' : format;

        if (rows.length > MAX_ROWS) {
          // Refused loudly rather than parked in a state nothing consumes. The
          // dataset was already loaded, so the alternative would be to throw the
          // work away after paying for it.
          await caller.supabase
            .from('export_jobs')
            .update({ status: 'FAILED', started_at: null, error: 'TOO_LARGE' })
            .eq('id', job.id);

          return fail(
            'EXPORT_TOO_LARGE',
            `That export covers ${rows.length} rows, above the ${MAX_ROWS}-row limit for a single file. ` +
              'Narrow it by choosing a single class, section or academic year.',
            413,
          );
        }

        const content = await render(rows, format, filename);
        const path = buildExportPath(caller.clerkUserId, extension);

        const { error: uploadError } = await caller.supabase.storage
          .from(BUCKET)
          .upload(path, content, {
            contentType: contentTypeFor(format),
            cacheControl: 'private, max-age=0, no-store',
            upsert: false,
          });

        if (uploadError) {
          throw new Error(`storage upload failed: ${uploadError.message}`);
        }

        await caller.supabase
          .from('export_jobs')
          .update({
            status: 'COMPLETED',
            storage_path: path,
            size_bytes: content.byteLength,
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id);

        await audit(caller, {
          action: 'export.complete',
          entityType: 'export_job',
          entityId: job.id,
          newValue: { kind, format, rows: rows.length },
        });

        return json({
          job: { ...job, status: 'COMPLETED', storage_path: path },
          queued: false,
          message: `Export ready — ${rows.length} row(s).`,
        });
      } catch (caught) {
        const message = (caught as Error)?.message ?? 'Unknown error';

        await caller.supabase
          .from('export_jobs')
          .update({
            status: 'FAILED',
            error: message.slice(0, 500),
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id);

        console.error('export generation failed', caught);
        return fail('INTERNAL_ERROR', 'The export could not be generated.', 500);
      }
    }),
);

/* -------------------------------------------------------------------------- */
/* Datasets                                                                     */
/* -------------------------------------------------------------------------- */

interface ExportRow {
  [key: string]: string | number | null;
}

async function buildDataset(
  caller: Awaited<ReturnType<typeof requireCaller>>,
  kind: string,
  params: Record<string, unknown>,
): Promise<{ rows: ExportRow[]; filename: string }> {
  const academicYearId = typeof params.academicYearId === 'string' ? params.academicYearId : null;
  const classId = typeof params.classId === 'string' ? params.classId : null;
  const sectionId = typeof params.sectionId === 'string' ? params.sectionId : null;
  const status = typeof params.status === 'string' ? params.status : null;

  if (kind === 'students') {
    let q = caller.supabase
      .from('v_students')
      .select('student_number, admission_number, roll_number, full_name, gender, status, class_name, section_name, academic_year_name, guardian_name, guardian_phone, guardian_email');

    if (academicYearId) q = q.eq('academic_year_id', academicYearId);
    if (classId) q = q.eq('class_id', classId);
    if (sectionId) q = q.eq('section_id', sectionId);
    if (status) q = q.eq('status', status);

    const { data, error } = await q
      .order('class_name')
      .order('roll_number', { ascending: true, nullsFirst: false })
      .limit(MAX_ROWS + 1);

    if (error) throw new Error(`students query failed: ${error.message}`);

    const rows = (data ?? []) as ExportRow[];
    const suffix = academicYearId ? '' : '-all-years';
    return { rows, filename: `students${suffix}` };
  }

  if (kind === 'marks' || kind === 'marks-sheet') {
    const subjectId = typeof params.subjectId === 'string' ? params.subjectId : null;
    const examId = typeof params.examId === 'string' ? params.examId : null;

    // A "marks sheet" export with neither subject nor exam is not a mark sheet, it
    // is the roster. Refusing beats silently exporting the wrong thing under a
    // name that promises marks.
    if (kind === 'marks-sheet' && !subjectId && !examId) {
      throw new Error('A marks-sheet export needs a subject, an exam, or both.');
    }

    let q = caller.supabase
      .from('v_marksheet')
      .select('student_number, roll_number, student_name, subject_code, subject_name, exam_name, marks_obtained, max_marks, percentage, grade, status, class_name, section_name');

    if (academicYearId) q = q.eq('academic_year_id', academicYearId);
    if (sectionId) q = q.eq('section_id', sectionId);
    if (subjectId) q = q.eq('subject_id', subjectId);
    if (examId) q = q.eq('exam_id', examId);

    const { data, error } = await q.order('student_name').limit(MAX_ROWS + 1);
    if (error) throw new Error(`marks query failed: ${error.message}`);

    // Name the file for what it actually contains, so a single-subject export is
    // not filed alongside a whole-section one and confuses everyone later.
    const scope = [subjectId && 'subject', examId && 'exam'].filter(Boolean).join('-') || 'section';
    return { rows: (data ?? []) as ExportRow[], filename: `marks-${scope}` };
  }

  if (kind === 'audit-log') {
    if (!(await hasPermission(caller, 'audit_log:view'))) {
      throw new Error('You do not have permission to export the audit log.');
    }

    const { data, error } = await caller.supabase
      .from('v_audit_logs')
      .select('created_at, user_email, action, entity_type, entity_id, reason')
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS + 1);

    if (error) throw new Error(`audit query failed: ${error.message}`);
    return { rows: (data ?? []) as ExportRow[], filename: 'audit-log' };
  }

  throw new Error(`Unknown export kind "${kind}".`);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                    */
/* -------------------------------------------------------------------------- */

async function render(rows: ExportRow[], format: Format, filename: string): Promise<Uint8Array> {
  if (format === 'csv') {
    return new TextEncoder().encode(toCsv(rows));
  }

  if (format === 'json') {
    return new TextEncoder().encode(JSON.stringify(rows, null, 2));
  }

  if (format === 'pdf') {
    // Print-ready HTML, exactly as the retired Worker produced.
    return new TextEncoder().encode(renderHtml(rows, filename));
  }

  const { buildWorkbook } = await import('../_shared/xlsx.ts');
  const workbook = buildWorkbook(rows, filename);
  return workbook as Uint8Array;
}

function contentTypeFor(format: Format): string {
  switch (format) {
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'pdf':
      return 'text/html; charset=utf-8';
    default:
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Minimal print-ready table. The browser handles pagination and "Save as PDF". */
function renderHtml(rows: ExportRow[], title: string): string {
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];

  const head = headers.map((h) => `<th>${escapeHtml(h.replace(/_/g, ' '))}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${headers.map((h) => `<td>${escapeHtml(row[h])}</td>`).join('')}</tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 14mm; size: A4; }
  * { box-sizing: border-box; }
  body { font: 11px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #0f172a; margin: 0; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  p.meta { margin: 0 0 12px; color: #64748b; font-size: 10px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; }
  th { background: #1e293b; color: #fff; font-weight: 600; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tr { page-break-inside: avoid; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${rows.length} row(s) &middot; generated ${escapeHtml(new Date().toLocaleString())}</p>
<table>
  <thead><tr>${head}</tr></thead>
  <tbody>${body}</tbody>
</table>
</body>
</html>`;
}