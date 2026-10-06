import { hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Mint a signed URL for a completed export.
 *
 * Separated from `export-generate` because generation and retrieval have different
 * authorization questions. Generating writes a new artefact; downloading hands out
 * a URL that bypasses Storage RLS entirely, so it is checked on its own terms.
 *
 * The caller must own the job, or hold `settings:manage`. `export_jobs.requested_by`
 * is a Clerk user id, so ownership is a direct comparison — no permission is
 * consulted for the owner's own files, which keeps a teacher from being able to
 * read a reviewer's exports by guessing an id.
 */

const BUCKET = 'generated-reports';
const SIGNED_URL_TTL_SECONDS = 120;

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'export:create'))) {
        return fail('FORBIDDEN', 'You do not have permission to download exports.', 403);
      }

      const { jobId } = await readJson<{ jobId?: string }>(request);

      if (!jobId) {
        return fail('VALIDATION_ERROR', 'A job id is required.', 400);
      }

      const { data: job, error } = await caller.supabase
        .from('export_jobs')
        .select('id, requested_by, status, storage_path, size_bytes, kind, format, error')
        .eq('id', jobId)
        .maybeSingle();

      if (error) {
        console.error('export_jobs read failed', error);
        return fail('INTERNAL_ERROR', 'The export could not be loaded.', 500);
      }

      if (!job) {
        return fail('NOT_FOUND', 'That export could not be found.', 404);
      }

      const isOwner = job.requested_by === caller.clerkUserId;
      const isAdmin = await hasPermission(caller, 'settings:manage');

      if (!isOwner && !isAdmin) {
        return fail('FORBIDDEN', 'That export belongs to someone else.', 403);
      }

      if (job.status !== 'COMPLETED') {
        // A queued or failed job has nothing to download; saying so is more
        // useful than handing back a URL that 404s.
        return fail(
          'CONFLICT',
          job.status === 'FAILED'
            ? `That export failed: ${job.error ?? 'no reason recorded'}. Request it again.`
            : `That export is ${job.status.toLowerCase()} and is not ready yet.`,
          409,
        );
      }

      if (!job.storage_path) {
        return fail('NOT_FOUND', 'That export has no stored file.', 404);
      }

      const { data: signed, error: signError } = await caller.supabase.storage
        .from(BUCKET)
        .createSignedUrl(job.storage_path, SIGNED_URL_TTL_SECONDS, { download: true });

      if (signError || !signed?.signedUrl) {
        console.error('createSignedUrl failed', signError);
        return fail('INTERNAL_ERROR', 'The export could not be prepared for download.', 500);
      }

      return json({
        url: signed.signedUrl,
        expiresIn: SIGNED_URL_TTL_SECONDS,
        sizeBytes: job.size_bytes,
        filename: filenameFor(job.kind, job.format, job.id),
      });
    }),
);

const EXTENSION: Record<string, string> = {
  csv: 'csv',
  xlsx: 'xlsx',
  json: 'json',
  // "PDF" is print-ready HTML, as it has always been in this app.
  pdf: 'html',
};

function filenameFor(kind: string, format: string, id: string): string {
  const extension = EXTENSION[format] ?? 'csv';
  const date = new Date().toISOString().slice(0, 10);
  return `${kind}-${date}-${id.slice(0, 8)}.${extension}`;
}