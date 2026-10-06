import {
  audit,
  enforceRateLimit,
  hasPermission,
  requireAssignment,
  requireCaller,
} from '../_shared/auth.ts';
import { fail, handle, json } from '../_shared/http.ts';
import { buildUploadPath, validateImageUpload } from '../_shared/upload.ts';

/**
 * Upload a mark sheet and register an OCR document.
 *
 * Port of `POST /api/ocr/upload` from the retired Worker. The two things worth
 * noting:
 *
 *  - The upload is stored at a generated path under the uploader's Clerk id, so
 *    the `storage.objects` policy in `0002_rls.sql` grants them access by
 *    construction. A client-supplied filename never reaches the path.
 *  - `requireAssignment` is called because this function uses the service role.
 *    Without it, `ocr:upload` alone would let any teacher attach a scan to a
 *    section they do not teach, and then read marks for it via the confirm step.
 */

const BUCKET = 'mark-sheets';

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      // Either permission is enough to upload: a teacher marking their own class,
      // or a reviewer/OCR role processing a sheet on someone else's behalf.
      const canUpload =
        (await hasPermission(caller, 'ocr:upload')) ||
        (await hasPermission(caller, 'marks:edit'));

      if (!canUpload) {
        return fail('FORBIDDEN', 'You do not have permission to upload mark sheets.', 403);
      }

      await enforceRateLimit(caller, 'ocrUpload');

      const form = await request.formData();
      const file = form.get('file');

      if (!(file instanceof File)) {
        return fail('VALIDATION_ERROR', 'No file was uploaded.', 400);
      }

      const academicYearId = str(form.get('academicYearId'));
      const classId = str(form.get('classId'));
      const sectionId = str(form.get('sectionId'));
      const subjectId = str(form.get('subjectId'));
      const examId = str(form.get('examId'));

      if (!academicYearId || !classId || !sectionId || !subjectId || !examId) {
        return fail('VALIDATION_ERROR', 'The mark sheet scope is incomplete.', 400);
      }

      // Business Rule 2: a teacher may only upload for classes they are assigned.
      // Staff with global OCR rights may upload for any section.
      if (!(await hasPermission(caller, 'ocr:view_all'))) {
        await requireAssignment(caller, { sectionId, subjectId, academicYearId });
      }

      const check = await validateImageUpload(file);
      if (!check.ok) {
        return fail(check.code ?? 'FILE_TYPE_NOT_ALLOWED', check.message ?? 'That file cannot be uploaded.', check.code === 'FILE_TOO_LARGE' ? 413 : 422);
      }

      const path = buildUploadPath(caller.clerkUserId, academicYearId, check.extension ?? 'bin');
      const bytes = new Uint8Array(await file.arrayBuffer());

      const { error: uploadError } = await caller.supabase.storage
        .from(BUCKET)
        .upload(path, bytes, {
          contentType: check.detectedType,
          // Private and uncached: an OCR result must never be served from a cache
          // that a shared machine could read.
          cacheControl: 'private, max-age=0, no-store',
          upsert: false,
        });

      if (uploadError) {
        console.error('storage upload failed', uploadError);
        return fail('INTERNAL_ERROR', 'The file could not be stored. Please try again.', 500);
      }

      const provider = Deno.env.get('OCR_PROVIDER') ?? 'manual';

      const { data: document, error: insertError } = await caller.supabase
        .from('ocr_documents')
        .insert({
          uploaded_by: caller.clerkUserId,
          academic_year_id: academicYearId,
          class_id: classId,
          section_id: sectionId,
          subject_id: subjectId,
          exam_id: examId,
          storage_bucket: BUCKET,
          storage_path: path,
          // Kept for display only; never used to build a path.
          original_filename: file.name.slice(0, 255),
          content_type: check.detectedType ?? file.type,
          size_bytes: bytes.byteLength,
          provider,
          status: 'UPLOADED',
        })
        .select()
        .single();

      if (insertError) {
        // Do not leave an orphaned object behind if the row could not be written.
        await caller.supabase.storage.from(BUCKET).remove([path]);
        console.error('ocr_documents insert failed', insertError);
        return fail('INTERNAL_ERROR', 'The upload could not be recorded. Please try again.', 500);
      }

      await audit(caller, {
        action: 'ocr.upload',
        entityType: 'ocr_document',
        entityId: document.id,
        newValue: { filename: file.name, sizeBytes: bytes.byteLength, provider },
      });

      // Processing is deferred to `ocr-process`, invoked by the caller. Doing it
      // inline would hold a function invocation open for the length of a vendor
      // OCR call, which is how you hit the execution timeout on a 100-page PDF.
      return json({ document, queued: true, message: 'Uploaded. Extraction has started.' }, 201);
    }),
);

function str(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}