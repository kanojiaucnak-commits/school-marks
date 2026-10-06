import { audit, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Turn confirmed OCR rows into draft marks.
 *
 * Port of `ocrService.confirmDocument()`. This is the highest-stakes function in
 * the OCR pipeline, because it is the point where an unverified machine reading
 * becomes a mark that a student's record depends on.
 *
 * Three rules are enforced here rather than in the UI, because the UI can be
 * bypassed and this cannot:
 *
 *  - Business Rule 1: a row that has not been verified is never written. Passing
 *    `markReviewed: false` writes nothing at all.
 *  - Business Rule 2: only rows whose matched student falls inside a section the
 *    caller is assigned to are written. An ambiguous or absent match is skipped,
 *    never guessed.
 *  - Confidence gate: below `OCR_CONFIDENCE.REVIEW_THRESHOLD` a row must have
 *    been manually verified.
 *
 * Rows are upserted in one statement so a failure cannot leave a partial sheet,
 * and the submission version is bumped to invalidate any open editor.
 */

const REVIEW_THRESHOLD = 0.7;
const AMBIGUITY_MARGIN = 0.06;

interface OcrRow {
  id: string;
  line_index: number;
  detected_marks: string | null;
  corrected_marks: string | null;
  corrected_status: string | null;
  confidence: number | null;
  verified: boolean;
  match_method: string;
  match_confidence: number | null;
  matched_student_id: string | null;
  remarks: string | null;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      const canConfirm =
        (await hasPermission(caller, 'ocr:confirm')) ||
        (await hasPermission(caller, 'ocr:review'));

      if (!canConfirm) {
        return fail('FORBIDDEN', 'You do not have permission to confirm OCR results.', 403);
      }

      const { documentId, markReviewed } = await readJson<{
        documentId?: string;
        markReviewed?: boolean;
      }>(request);

      if (!documentId) {
        return fail('VALIDATION_ERROR', 'A document id is required.', 400);
      }

      const { data: document, error: docError } = await caller.supabase
        .from('ocr_documents')
        .select('id, uploaded_by, section_id, subject_id, exam_id, academic_year_id, status')
        .eq('id', documentId)
        .maybeSingle();

      if (docError) {
        console.error('document read failed', docError);
        return fail('INTERNAL_ERROR', 'Could not load the document.', 500);
      }

      if (!document) {
        return fail('NOT_FOUND', 'That document could not be found.', 404);
      }

      if (document.status === 'CONFIRMED') {
        return fail('CONFLICT', 'These results have already been confirmed.', 409);
      }

      // Business Rule 1, enforced server-side. The UI's checkbox is a convenience.
      if (markReviewed !== true) {
        return fail(
          'OCR_LOW_CONFIDENCE',
          'Confirm that you have reviewed every row before creating marks.',
          422,
        );
      }

      const { data: rows, error: rowsError } = await caller.supabase
        .from('ocr_results')
        .select('*')
        .eq('document_id', documentId)
        .order('line_index');

      if (rowsError) {
        console.error('ocr_results read failed', rowsError);
        return fail('INTERNAL_ERROR', 'Could not load the extracted rows.', 500);
      }

      const results = (rows ?? []) as unknown as OcrRow[];

      if (results.length === 0) {
        return fail('OCR_NOT_COMPLETED', 'No rows were extracted from this mark sheet.', 422);
      }

      // Which students may this caller actually write marks for?
      const { data: roster, error: rosterError } = await caller.supabase
        .from('v_students')
        .select('id, section_id')
        .eq('section_id', document.section_id)
        .eq('academic_year_id', document.academic_year_id);

      if (rosterError) {
        console.error('roster read failed', rosterError);
        return fail('INTERNAL_ERROR', 'Could not load the class roster.', 500);
      }

      const rosterIds = new Set(((roster ?? []) as Array<{ id: string }>).map((r) => r.id));
      const seesEverything = await hasPermission(caller, 'marks:view_all');

      const { data: exam } = await caller.supabase
        .from('exams')
        .select('id, max_marks')
        .eq('id', document.exam_id)
        .maybeSingle();

      // Mirror of the marks-entry flow: a per-sheet override wins, then the exam
      // default. Bulk-importing from a scan must honour the same maximum the
      // teacher would type marks against.
      const { data: sheetMax } = await caller.supabase
        .from('sheet_max_marks')
        .select('max_marks')
        .eq('academic_year_id', document.academic_year_id)
        .eq('section_id', document.section_id)
        .eq('subject_id', document.subject_id)
        .eq('exam_id', document.exam_id)
        .maybeSingle();

      const maxMarks =
        sheetMax && typeof sheetMax !== 'undefined'
          ? Number((sheetMax as { max_marks: number }).max_marks)
          : Number((exam as { max_marks?: number } | null)?.max_marks ?? 0);

      const accepted: Array<Record<string, unknown>> = [];
      const skipped: Array<{ line: number; reason: string }> = [];

      for (const row of results) {
        // Never write an unverified row (Business Rule 1).
        if (!row.verified) {
          skipped.push({ line: row.line_index, reason: 'Not verified' });
          continue;
        }

        // An unmatched or low-confidence match is never guessed.
        if (!row.matched_student_id || row.match_method === 'none') {
          skipped.push({ line: row.line_index, reason: 'No student matched' });
          continue;
        }

        // Business Rule 2, enforced against the actual roster.
        if (!seesEverything && !rosterIds.has(row.matched_student_id)) {
          skipped.push({ line: row.line_index, reason: 'Student is not in this section' });
          continue;
        }

        // An ambiguous match must be resolved by hand.
        if (
          row.match_confidence !== null &&
          row.match_method === 'fuzzy_name' &&
          row.match_confidence < 1 - AMBIGUITY_MARGIN &&
          !row.verified
        ) {
          skipped.push({ line: row.line_index, reason: 'Match is ambiguous' });
          continue;
        }

        // Confidence gate: a low-confidence row needs a human, not a threshold.
        if (row.confidence !== null && row.confidence < REVIEW_THRESHOLD && !row.verified) {
          skipped.push({ line: row.line_index, reason: 'Confidence too low' });
          continue;
        }

        const status = normaliseStatus(row.corrected_status);
        const marks = row.corrected_marks ?? row.detected_marks;
        const numeric = toNumber(marks);

        if (status !== 'PRESENT') {
          // Non-numeric statuses carry no mark; the CHECK constraint requires it.
          accepted.push({
            student_id: row.matched_student_id,
            subject_id: document.subject_id,
            exam_id: document.exam_id,
            academic_year_id: document.academic_year_id,
            entered_by: caller.clerkUserId,
            max_marks: maxMarks,
            marks_obtained: null,
            status,
            remarks: row.remarks ?? null,
            source: 'ocr',
            ocr_document_id: documentId,
          });
          continue;
        }

        if (numeric === null) {
          skipped.push({ line: row.line_index, reason: 'No mark could be read' });
          continue;
        }

        // Business Rule 4, refused before it reaches the database.
        if (maxMarks > 0 && numeric > maxMarks) {
          skipped.push({ line: row.line_index, reason: `Mark ${numeric} exceeds the maximum of ${maxMarks}` });
          continue;
        }

        accepted.push({
          student_id: row.matched_student_id,
          subject_id: document.subject_id,
          exam_id: document.exam_id,
          academic_year_id: document.academic_year_id,
          entered_by: caller.clerkUserId,
          max_marks: maxMarks,
          marks_obtained: numeric,
          status: 'PRESENT',
          remarks: row.remarks ?? null,
          source: 'ocr',
          ocr_document_id: documentId,
        });
      }

      if (accepted.length > 0) {
        // One statement, so a partial sheet is impossible. `marks_derive_grade`
        // then computes percentage and grade from the active scheme.
        const { error: upsertError } = await caller.supabase
          .from('marks')
          .upsert(accepted, {
            onConflict: 'student_id,subject_id,exam_id,academic_year_id',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.error('marks upsert failed', upsertError);
          return fail('INTERNAL_ERROR', 'The marks could not be saved.', 500);
        }

        // Ensure the sheet exists and bump its version, so an open marks grid
        // detects the change rather than overwriting it (Business Rule 6).
        //
        // The insert is scoped to the section's class, which is looked up rather
        // than guessed — `mark_submissions` is uniquely keyed on
        // (year, class, section, subject, exam) and a wrong class_id would create
        // a duplicate sheet that the grid never reads.
        const { data: section } = await caller.supabase
          .from('sections')
          .select('class_id')
          .eq('id', document.section_id)
          .maybeSingle();

        const classId = (section as { class_id?: string } | null)?.class_id;
        if (!classId) {
          return fail('INTERNAL_ERROR', 'The section for this mark sheet is missing.', 500);
        }

        await caller.supabase
          .from('mark_submissions')
          .upsert(
            {
              academic_year_id: document.academic_year_id,
              class_id: classId,
              section_id: document.section_id,
              subject_id: document.subject_id,
              exam_id: document.exam_id,
              teacher_id: caller.clerkUserId,
              status: 'DRAFT',
            },
            {
              onConflict: 'academic_year_id,class_id,section_id,subject_id,exam_id',
              ignoreDuplicates: true,
            },
          );

        // Now bump the version of whatever sheet exists. `mark_submissions_version`
        // is a BEFORE UPDATE trigger, so this increments atomically.
        await caller.supabase
          .from('mark_submissions')
          .update({ updated_at: new Date().toISOString() })
          .eq('academic_year_id', document.academic_year_id)
          .eq('section_id', document.section_id)
          .eq('subject_id', document.subject_id)
          .eq('exam_id', document.exam_id);
      }

      await caller.supabase
        .from('ocr_documents')
        .update({
          status: 'CONFIRMED',
          confirmed_marks_count: accepted.length,
          completed_at: new Date().toISOString(),
        })
        .eq('id', documentId);

      await audit(caller, {
        action: 'ocr.confirm',
        entityType: 'ocr_document',
        entityId: documentId,
        newValue: { created: accepted.length, skipped: skipped.length },
        reason: skipped.length > 0 ? `${skipped.length} rows skipped` : null,
      });

      const message = skipped.length === 0
        ? `${accepted.length} mark(s) written as drafts.`
        : `${accepted.length} mark(s) written. ${skipped.length} row(s) skipped — review them and retry.`;

      return json({
        created: accepted.length,
        updated: 0,
        skipped: skipped.length,
        skippedDetail: skipped.slice(0, 50),
        message,
      });
    }),
);

function normaliseStatus(value: string | null): 'PRESENT' | 'ABSENT' | 'EXEMPTED' | 'MEDICAL' {
  const upper = (value ?? '').toUpperCase();
  if (upper === 'ABSENT' || upper === 'EXEMPTED' || upper === 'MEDICAL') return upper;
  return 'PRESENT';
}

/** Parse a mark, tolerating `37/40`, `92%` and stray punctuation. */
function toNumber(value: string | null): number | null {
  if (!value) return null;

  const match = value.match(/-?\d+(\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}