import { audit, enforceRateLimit, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Write the students a preview validated.
 *
 * Port of `importService.commitImport()`.
 *
 * The insert is chunked rather than done in one statement. The retired Worker
 * chunked at 40 rows because D1 caps a statement at 100 bound parameters; Postgres
 * has no such hard limit but does have a 65535-parameter ceiling, so chunking
 * still applies — at a larger size, and only for safety rather than necessity.
 *
 * Every row is inserted in ONE multi-row statement per chunk, so a chunk either
 * lands completely or not at all. A partially-imported class is far worse than a
 * failed import, because it looks successful and quietly enrols half a year.
 *
 * `normalized_name` is computed here, matching `normalizeName()` in
 * @school/shared, because OCR matching depends on students being stored in the
 * same normalised form the matcher compares against.
 */

const CHUNK_SIZE = 200;

interface ParsedStudent {
  studentNumber: string;
  fullName: string;
  admissionNumber: string | null;
  rollNumber: number | null;
  dateOfBirth: string | null;
  gender: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
}

interface StoredPreviewRow {
  row: number;
  parsed: ParsedStudent | null;
  errors: string[];
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'student:import'))) {
        return fail('FORBIDDEN', 'You do not have permission to import students.', 403);
      }

      // Writes up to 200 students per chunk, so a loop would be fast and
      // destructive.
      await enforceRateLimit(caller, 'importRun');

      const { batchId, classId, sectionId, skipInvalidRows = true } = await readJson<{
        batchId?: string;
        classId?: string;
        sectionId?: string;
        skipInvalidRows?: boolean;
      }>(request);

      if (!batchId) {
        return fail('VALIDATION_ERROR', 'A batch id is required.', 400);
      }

      if (!classId || !sectionId) {
        return fail(
          'VALIDATION_ERROR',
          'The import needs a destination class and section.',
          422,
        );
      }

      const { data: batch, error: batchError } = await caller.supabase
        .from('import_batches')
        .select('*')
        .eq('id', batchId)
        .maybeSingle();

      if (batchError) {
        console.error('import_batches read failed', batchError);
        return fail('INTERNAL_ERROR', 'The import batch could not be loaded.', 500);
      }

      if (!batch) {
        return fail('NOT_FOUND', 'That import batch could not be found.', 404);
      }

      // Only the uploader may commit their own preview.
      if (batch.uploaded_by !== caller.clerkUserId && !(await hasPermission(caller, 'import:manage'))) {
        return fail('FORBIDDEN', 'You cannot commit someone else’s import.', 403);
      }

      if (batch.status === 'IMPORTED') {
        return fail('CONFLICT', 'This import has already been committed.', 409);
      }

      if (batch.status === 'FAILED') {
        return fail('CONFLICT', 'This import previously failed. Run the preview again.', 409);
      }

      // The preview only ever stored the first 200 rows (see import-preview), so a
      // file larger than that cannot be committed whole. Refusing loudly beats
      // importing an arbitrary subset.
      const totalRows = Number(batch.total_rows ?? 0);
      const storedRows = parsePreviewRows(batch.rows);

      if (totalRows > storedRows.length) {
        return fail(
          'VALIDATION_ERROR',
          `Only the first ${storedRows.length} of ${totalRows} rows were previewed. Split the file into smaller batches and import them one at a time.`,
          422,
        );
      }

      const invalid = storedRows.filter((row) => !row.parsed);

      if (invalid.length > 0 && !skipInvalidRows) {
        return fail(
          'IMPORT_VALIDATION_FAILED',
          `${invalid.length} row(s) have errors and cannot be imported. Fix them, or choose to skip invalid rows.`,
          422,
          { errorRows: invalid.length, rows: invalid.slice(0, 50) },
        );
      }

      const ready = storedRows.filter((row) => row.parsed).map((row) => row.parsed!);

      if (ready.length === 0) {
        await caller.supabase
          .from('import_batches')
          .update({ status: 'FAILED', completed_at: new Date().toISOString() })
          .eq('id', batchId);

        return fail('IMPORT_VALIDATION_FAILED', 'No valid rows to import.', 422);
      }

      // Verify the destination exists and belongs to the batch's year, so a
      // mistyped section id cannot file students into another year.
      const { data: section } = await caller.supabase
        .from('v_class_sections')
        .select('class_id, section_id, academic_year_id')
        .eq('section_id', sectionId)
        .maybeSingle();

      const target = section as
        | { class_id: string; section_id: string; academic_year_id: string }
        | null;

      if (!target || target.class_id !== classId) {
        return fail('VALIDATION_ERROR', 'That class and section do not belong together.', 422);
      }

      if (target.academic_year_id !== batch.academic_year_id) {
        return fail(
          'VALIDATION_ERROR',
          'That section belongs to a different academic year than the import.',
          422,
        );
      }

      const academicYearId = String(batch.academic_year_id);

      // Re-check duplicates at commit time. The preview may be minutes or hours
      // old, and someone may have enrolled a student in between — the unique
      // constraint would catch it, but as an opaque error.
      const { data: existing } = await caller.supabase
        .from('students')
        .select('student_number')
        .eq('academic_year_id', academicYearId);

      const taken = new Set(
        ((existing ?? []) as Array<{ student_number: string }>).map((r) =>
          r.student_number.toLowerCase(),
        ),
      );

      const seen = new Set<string>();
      const toInsert: Array<Record<string, unknown>> = [];
      let skippedDuplicates = 0;

      for (const student of ready) {
        const key = student.studentNumber.toLowerCase();
        if (taken.has(key) || seen.has(key)) {
          skippedDuplicates += 1;
          continue;
        }
        seen.add(key);

        toInsert.push({
          academic_year_id: academicYearId,
          class_id: classId,
          section_id: sectionId,
          student_number: student.studentNumber,
          admission_number: student.admissionNumber,
          roll_number: student.rollNumber,
          full_name: student.fullName,
          normalized_name: normalizeName(student.fullName),
          date_of_birth: student.dateOfBirth,
          gender: student.gender,
          guardian_name: student.guardianName,
          guardian_phone: student.guardianPhone,
          guardian_email: student.guardianEmail,
          status: 'active',
        });
      }

      if (toInsert.length === 0) {
        await caller.supabase
          .from('import_batches')
          .update({ status: 'FAILED', completed_at: new Date().toISOString() })
          .eq('id', batchId);

        return fail(
          'CONFLICT',
          'Every student in this file is already enrolled for this year.',
          409,
        );
      }

      let created = 0;

      for (let offset = 0; offset < toInsert.length; offset += CHUNK_SIZE) {
        const chunk = toInsert.slice(offset, offset + CHUNK_SIZE);

        const { error } = await caller.supabase.from('students').insert(chunk);
        if (error) {
          // Report exactly how far it got, so the user knows the state is partial
          // rather than guessing.
          console.error('students chunk insert failed', error);
          await caller.supabase
            .from('import_batches')
            .update({
              status: 'FAILED',
              error: `Failed after ${created} row(s): ${error.message}`.slice(0, 500),
              created_count: created,
              completed_at: new Date().toISOString(),
            })
            .eq('id', batchId);

          return fail(
            'INTERNAL_ERROR',
            `The import failed after ${created} of ${toInsert.length} student(s) were added. Fix the cause and run the import again.`,
            500,
          );
        }

        created += chunk.length;
      }

      await caller.supabase
        .from('import_batches')
        .update({
          status: 'IMPORTED',
          created_count: created,
          skipped_count: invalid.length + skippedDuplicates,
          completed_at: new Date().toISOString(),
        })
        .eq('id', batchId);

      await audit(caller, {
        action: 'students.import',
        entityType: 'import_batch',
        entityId: batchId,
        newValue: {
          created,
          skipped: invalid.length + skippedDuplicates,
          classId,
          sectionId,
          academicYearId,
        },
      });

      const skippedTotal = invalid.length + skippedDuplicates;

      return json({
        created,
        updated: 0,
        skipped: skippedTotal,
        message:
          skippedTotal === 0
            ? `${created} student(s) added.`
            : `${created} student(s) added. ${skippedTotal} row(s) skipped.`,
      });
    }),
);

function parsePreviewRows(value: unknown): StoredPreviewRow[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as StoredPreviewRow[];
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) return value as StoredPreviewRow[];
  return [];
}

/**
 * Mirrors `normalizeName()` in @school/shared.
 *
 * Duplicated rather than imported because Edge Functions cannot resolve the
 * workspace package. The two must agree: OCR matching compares a detected name
 * against `students.normalized_name`, and a divergence means names stop matching
 * after an import.
 */
function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}