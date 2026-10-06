import { canReadDocument, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Mint a short-lived signed URL for an uploaded mark sheet.
 *
 * Replaces `GET /api/ocr/:id/file`, which streamed the bytes through the Worker.
 *
 * This is the function most likely to become an authorization hole, because it
 * hands out a URL that bypasses RLS entirely. Two checks stand in front of it:
 *
 *  1. `canReadDocument` — uploader, `ocr:view_all`, `marks:view_all`, or an
 *     assignment to the same section and subject.
 *  2. A one-minute expiry, so a leaked URL is not a permanent one.
 *
 * The retired code allowed "same section+subject assignment" deliberately: a
 * teacher who teaches the section has a legitimate reason to see the sheet. It
 * does NOT extend to a teacher assigned to the subject in a different section,
 * which is why the check compares all three keys and not just the subject.
 */

const SIGNED_URL_TTL_SECONDS = 60;

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
        .select('id, uploaded_by, section_id, subject_id, academic_year_id, storage_bucket, storage_path')
        .eq('id', documentId)
        .maybeSingle();

      if (error) {
        console.error('ocr_documents read failed', error);
        return fail('INTERNAL_ERROR', 'Could not load the document.', 500);
      }

      if (!document) {
        // 404 rather than 403: confirming a document exists is itself a small
        // disclosure, and there is nothing useful to tell an unauthorised caller.
        return fail('NOT_FOUND', 'That document could not be found.', 404);
      }

      const allowed = await canReadDocument(caller, {
        uploaded_by: document.uploaded_by,
        section_id: document.section_id,
        subject_id: document.subject_id,
        academic_year_id: document.academic_year_id,
      });

      if (!allowed) {
        return fail('FORBIDDEN', 'You do not have access to this mark sheet.', 403);
      }

      const { data: signed, error: signError } = await caller.supabase.storage
        .from(document.storage_bucket ?? 'mark-sheets')
        .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS, {
          // Inline for <img>/<object> previews; `Content-Disposition: attachment`
          // would force a download instead of displaying the scan.
          download: false,
        });

      if (signError || !signed?.signedUrl) {
        console.error('createSignedUrl failed', signError);
        return fail('INTERNAL_ERROR', 'The file could not be prepared for viewing.', 500);
      }

      return json({
        url: signed.signedUrl,
        expiresIn: SIGNED_URL_TTL_SECONDS,
        contentType: 'application/octet-stream',
      });
    }),
);