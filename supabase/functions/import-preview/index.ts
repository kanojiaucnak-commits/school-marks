import { enforceRateLimit, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json } from '../_shared/http.ts';
import { validateImportUpload } from '../_shared/upload.ts';
import { parseCsvToObjects } from '../_shared/csv.ts';

/**
 * Parse an uploaded student list and report what would happen.
 *
 * Port of `importService.createPreview()` + `validateImport()`.
 *
 * Two things worth preserving from the original:
 *
 *  - **Nothing is written.** A preview only produces a batch record holding the
 *    parsed rows, which the user then reviews and commits. That is what makes it
 *    safe to try an import against a live database.
 *  - **Every bad row is reported, not just the first.** A school importing 400
 *    students needs to know all 12 that will fail and why, not to fix them one
 *    file upload at a time.
 *
 * The 5000-row cap is a guard against a mistakenly selected enormous file; it is
 * applied after parsing because the row count is only known then.
 */

const MAX_ROWS = 5000;
const PREVIEW_LIMIT = 200;

interface PreviewRow {
  row: number;
  raw: Record<string, string>;
  parsed: Record<string, unknown> | null;
  errors: string[];
  existingStudentId: string | null;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'student:import'))) {
        return fail('FORBIDDEN', 'You do not have permission to import students.', 403);
      }

      await enforceRateLimit(caller, 'importRun');

      const form = await request.formData();
      const file = form.get('file');
      const academicYearId = form.get('academicYearId');

      if (!(file instanceof File)) {
        return fail('VALIDATION_ERROR', 'No file was uploaded.', 400);
      }

      if (typeof academicYearId !== 'string' || !academicYearId) {
        return fail('VALIDATION_ERROR', 'An academic year is required.', 400);
      }

      const check = await validateImportUpload(file);
      if (!check.ok) {
        return fail(
          check.code ?? 'FILE_TYPE_NOT_ALLOWED',
          check.message ?? 'That file cannot be imported.',
          check.code === 'FILE_TOO_LARGE' ? 413 : 422,
        );
      }

      const text = new TextDecoder('utf-8', { fatal: false }).decode(await file.arrayBuffer());

      let records: Array<Record<string, string>>;

      if (check.detectedType === 'application/zip') {
        // XLSX is a ZIP of XML; parsing it properly needs a workbook reader, which
        // is not something to hand-roll inside a request handler. CSV covers the
        // real use, and the template the app offers is CSV.
        return fail(
          'FILE_TYPE_NOT_ALLOWED',
          'XLSX import is not supported yet. Export your sheet as CSV and try again.',
          422,
        );
      }

      try {
        records = parseCsvToObjects(text);
      } catch {
        return fail('FILE_CORRUPT', 'That file could not be read as CSV.', 422);
      }

      if (records.length === 0) {
        return fail('VALIDATION_ERROR', 'That file has no data rows.', 422);
      }

      if (records.length > MAX_ROWS) {
        return fail(
          'FILE_TOO_LARGE',
          `That file has ${records.length} rows. The limit is ${MAX_ROWS}. Split it into smaller files.`,
          413,
        );
      }

      // Resolve the destination once, so every row is validated against the same
      // place rather than guessing per row.
      const target = await resolveTarget(caller, academicYearId, {
        classId: typeof form.get('classId') === 'string' ? (form.get('classId') as string) : null,
        sectionId: typeof form.get('sectionId') === 'string' ? (form.get('sectionId') as string) : null,
      });

      if ('error' in target) {
        return fail('VALIDATION_ERROR', target.error, 422);
      }

      const { classId, sectionId } = target;

      const existing = await existingStudentNumbers(caller, academicYearId);

      const rows: PreviewRow[] = records.map((raw, index) => {
        const errors: string[] = [];
        const rowNumber = index + 2; // +1 for zero-index, +1 for the header row

        const fullName = (raw['Full Name'] ?? raw['full_name'] ?? raw['name'] ?? '').trim();
        const studentNumber = (
          raw['Student Number'] ??
          raw['student_number'] ??
          raw['Student ID'] ??
          ''
        ).trim();

        if (!fullName) errors.push('Full name is required.');
        if (!studentNumber) errors.push('Student number is required.');
        if (fullName && studentNumber && existing.has(studentNumber.toLowerCase())) {
          errors.push('A student with this number already exists for this year.');
        }

        const rollRaw = (raw['Roll Number'] ?? raw['roll_number'] ?? '').trim();
        let rollNumber: number | null = null;
        if (rollRaw) {
          rollNumber = Number(rollRaw);
          if (!Number.isInteger(rollNumber) || rollNumber < 0) {
            errors.push('Roll number must be a whole number of 0 or more.');
            rollNumber = null;
          }
        }

        return {
          row: rowNumber,
          raw,
          parsed: errors.length === 0
            ? {
                studentNumber,
                fullName,
                admissionNumber: (raw['Admission Number'] ?? raw['admission_number'] ?? '').trim() || null,
                rollNumber,
                dateOfBirth: normaliseDate(raw['Date of Birth'] ?? raw['date_of_birth']),
                gender: normaliseGender(raw['Gender'] ?? raw['gender']),
                guardianName: (raw['Guardian Name'] ?? raw['guardian_name'] ?? '').trim() || null,
                guardianPhone: (raw['Guardian Phone'] ?? raw['guardian_phone'] ?? '').trim() || null,
                guardianEmail: (raw['Guardian Email'] ?? raw['guardian_email'] ?? '').trim() || null,
              }
            : null,
          errors,
          existingStudentId: null,
        };
      });

      const validRows = rows.filter((row) => row.errors.length === 0).length;
      const errorRows = rows.length - validRows;

      const batchId = crypto.randomUUID();

      const { error: insertError } = await caller.supabase.from('import_batches').insert({
        id: batchId,
        uploaded_by: caller.clerkUserId,
        filename: file.name.slice(0, 255),
        academic_year_id: academicYearId,
        status: 'VALIDATED',
        total_rows: rows.length,
        valid_rows: validRows,
        error_rows: errorRows,
        // Only the first slice is stored. The full set for a 5000-row file would
        // be megabytes of jsonb in one row, and the commit step re-parses the
        // validated rows from the batch rather than the original upload.
        rows: JSON.stringify(rows.slice(0, PREVIEW_LIMIT)),
        errors: JSON.stringify(
          rows.filter((r) => r.errors.length > 0).slice(0, PREVIEW_LIMIT),
        ),
      });

      if (insertError) {
        console.error('import_batches insert failed', insertError);
        return fail('INTERNAL_ERROR', 'The preview could not be saved.', 500);
      }

      return json({
        batchId,
        academicYearId,
        classId,
        sectionId,
        totalRows: rows.length,
        validRows,
        errorRows,
        // 200 of each; the counts above are the true totals.
        rows: rows.slice(0, PREVIEW_LIMIT),
        truncated: rows.length > PREVIEW_LIMIT,
        message:
          errorRows === 0
            ? `All ${validRows} row(s) look good. Review and commit to add them.`
            : `${validRows} row(s) are ready. ${errorRows} row(s) need fixing — review the errors below.`,
      });
    }),
);

/**
 * The import's destination.
 *
 * The preview response carries `classId`/`sectionId` so the commit step and the
 * confirmation dialog agree on where the rows will land. When the sheet names a
 * class or section, that is used; otherwise the first one in the year.
 *
 * There is no safe way to infer the *correct* section from a flat CSV — a school
 * may well have one class with several sections. Guessing would silently file
 * students under the wrong section, so an ambiguous import is refused instead and
 * the caller must pass the target explicitly.
 */
async function resolveTarget(
  caller: Awaited<ReturnType<typeof requireCaller>>,
  academicYearId: string,
  requested: { classId: string | null; sectionId: string | null },
): Promise<{ classId: string; sectionId: string } | { error: string }> {
  if (requested.classId && requested.sectionId) {
    return { classId: requested.classId, sectionId: requested.sectionId };
  }

  // A section implies its class, so one of the two is often enough.
  if (requested.sectionId) {
    const { data } = await caller.supabase
      .from('sections')
      .select('class_id')
      .eq('id', requested.sectionId)
      .maybeSingle();

    const classId = (data as { class_id?: string } | null)?.class_id;
    if (classId) return { classId, sectionId: requested.sectionId };
  }

  const { data: sections } = await caller.supabase
    .from('v_class_sections')
    .select('class_id, section_id')
    .eq('academic_year_id', academicYearId)
    .order('label')
    .limit(2);

  const available = (sections ?? []) as Array<{ class_id: string; section_id: string }>;

  if (available.length === 1 && available[0]) {
    return { classId: available[0].class_id, sectionId: available[0].section_id };
  }

  return {
    error:
      available.length === 0
        ? 'This academic year has no sections yet. Create a class and section before importing students.'
        : 'This academic year has more than one section, so the import needs to know where the students belong. Choose a class and section on the import screen.',
  };
}

/** Student numbers already enrolled for the year, for duplicate detection. */
async function existingStudentNumbers(
  caller: Awaited<ReturnType<typeof requireCaller>>,
  academicYearId: string,
): Promise<Set<string>> {
  const { data } = await caller.supabase
    .from('students')
    .select('student_number')
    .eq('academic_year_id', academicYearId);

  return new Set(((data ?? []) as Array<{ student_number: string }>).map((r) => r.student_number.toLowerCase()));
}

function normaliseDate(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;

  // Accept YYYY-MM-DD and DD/MM/YYYY. Ambiguous input is rejected rather than
  // guessed: a student enrolled on the wrong date is a data-quality problem that
  // is very hard to find later.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slashed = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const day = slashed[1]!.padStart(2, '0');
    const month = slashed[2]!.padStart(2, '0');
    return `${slashed[3]}-${month}-${day}`;
  }

  return null;
}

function normaliseGender(value: string | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'male' || raw === 'm') return 'male';
  if (raw === 'female' || raw === 'f') return 'female';
  if (raw === 'other') return 'other';
  return null;
}