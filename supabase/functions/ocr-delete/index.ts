import { audit, canReadDocument, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Delete an OCR document and the file behind it.
 *
 * Both halves, deliberately. A database-only delete would leave the uploaded
 * mark sheet in Storage forever — which is a list of individual students' scores,
 * retained with no way to find or remove it. That is exactly the kind of orphan a
 * GDPR request turns into an incident.
 *
 * Order is file-then-row: if the row were deleted first and the file removal then
 * failed, the object would be unreachable and permanently unidentifiable. Removing
 * the object first means a failure leaves an intact document the user can retry.
 */

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      const { documentId } = await readJson<{ documentId?: string }>(request);

      if (!documentId) {
        return fail('VALIDATION_ERROR', 'A document id is required.', 400);
      }

      const { data: document, error } = await caller.supabase
        .from('ocr_documents')
        .select('id, uploaded_by, section_id, subject_id, academic_year_id, storage_bucket, storage_path, original_filename, confirmed_marks_count, status')
        .eq('id', documentId)
        .maybeSingle();

      if (error) {
        console.error('ocr_documents read failed', error);
        return fail('INTERNAL_ERROR', 'Could not load the document.', 500);
      }

      if (!document) {
        return fail('NOT_FOUND', 'That document could not be found.', 404);
      }

      // The uploader may remove their own upload. Anything already confirmed
      // becomes a deliberate act: the marks derived from it exist independently,
      // and deleting the scan must not delete a student's record.
      const isUploader = document.uploaded_by === caller.clerkUserId;
      const canDelete = (await hasPermission(caller, 'ocr:confirm')) || (await hasPermission(caller, 'ocr:view_all'));

      if (!isUploader && !canDelete) {
        return fail('FORBIDDEN', 'You cannot delete this mark sheet.', 403);
      }

      // Only a reviewer may delete a document that has already become marks.
      if (document.status === 'CONFIRMED' && !(await hasPermission(caller, 'ocr:confirm'))) {
        return fail(
          'FORBIDDEN',
          'These results have already been turned into marks. A reviewer has to remove them.',
          403,
        );
      }

      // The uploader is still subject to the same read rule, so deleting cannot be
      // used to probe for documents one may not otherwise see.
      if (!isUploader) {
        const allowed = await canReadDocument(caller, {
          uploaded_by: document.uploaded_by,
          section_id: document.section_id,
          subject_id: document.subject_id,
          academic_year_id: document.academic_year_id,
        });

        if (!allowed) {
          return fail('FORBIDDEN', 'You do not have access to this mark sheet.', 403);
        }
      }

      const { error: removeError } = await caller.supabase.storage
        .from(document.storage_bucket ?? 'mark-sheets')
        .remove([document.storage_path]);

      if (removeError) {
        // Leave the row intact so the user can retry; an orphaned object with no
        // record pointing at it is the worse outcome.
        console.error('storage remove failed', removeError);
        return fail(
          'INTERNAL_ERROR',
          'The file could not be removed. Nothing was deleted — please try again.',
          500,
        );
      }

      // `ocr_results` cascades from the document row.
      const { error: deleteError } = await caller.supabase
        .from('ocr_documents')
        .delete()
        .eq('id', documentId);

      if (deleteError) {
        console.error('ocr_documents delete failed', deleteError);
        return fail('INTERNAL_ERROR', 'The record could not be deleted.', 500);
      }

      await audit(caller, {
        action: 'ocr.delete',
        entityType: 'ocr_document',
        entityId: documentId,
        reason: `Removed "${document.original_filename}"`,
        newValue: { confirmedMarks: document.confirmed_marks_count },
      });

      return json({
        deleted: true,
        message:
          document.status === 'CONFIRMED'
            ? 'Mark sheet removed. The marks already created from it were kept.'
            : 'Mark sheet removed.',
      });
    }),
);