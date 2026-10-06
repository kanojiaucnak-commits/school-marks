import type { OcrDocument, OcrResultRow, ExportJob, ImportPreview, ImportResult } from '@school/shared';
import { getSupabase } from '../supabase';
import { edgeFetch, getEdgeToken } from '../edge';
import type { OcrPage } from '../ocr/extract';
import {
  QueryError,
  applySearch,
  camel,
  camelMany,
  orSearch,
  paginate,
  toQueryError,
  type ListParams,
  type ListResponse,
} from '../query';

/**
 * Files and the three features that need a server: OCR, exports, imports.
 *
 * None of these can run in the browser. They call Supabase Edge Functions, which
 * are the Deno successors to the retired Worker — same responsibilities, new
 * runtime. Uploaded bytes live in private Storage buckets; nothing is ever
 * publicly addressable (Business Rule 9).
 */

/* -------------------------------------------------------------------------- */
/* Uploads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Upload a mark sheet.
 *
 * The path is generated server-side and scoped to the uploader's Clerk id:
 * `uploads/<clerkId>/<uuid>.<ext>`. A client-supplied filename never becomes a
 * storage path, so a file called `../../etc/passwd.pdf` is stored as an opaque
 * name and `original_filename` keeps the human-readable label for display only.
 */
export async function uploadMarkSheet(input: {
  file: File;
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
}): Promise<OcrDocument> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('academicYearId', input.academicYearId);
  form.append('classId', input.classId);
  form.append('sectionId', input.sectionId);
  form.append('subjectId', input.subjectId);
  form.append('examId', input.examId);

  const result = await edgeFetch<{ document: Record<string, unknown> }>('ocr-upload', {
    method: 'POST',
    body: form,
  });

  return camel<OcrDocument>(result.document)!;
}

/**
 * Hand pages recognised in the browser to `ocr-process`.
 *
 * This is the seam between the two halves of client-side OCR:
 *
 *  - The browser (`lib/ocr/extract.ts`) ran Tesseract.js and has the words and
 *    their boxes. That is all it sends.
 *  - The function re-derives the rows: which tokens are the identifier, which
 *    are the name, which is the mark, and which student on the roster each line
 *    is. Those need the roster, which is RLS-protected, and the writes must be
 *    atomic, so they stay server-side.
 *
 * Sending only `pages` matters for correctness as well as for size. The function
 * derives `matchedStudentId` from the roster itself and ignores anything
 * resembling a pre-matched row in the payload, so a caller cannot hand in a
 * decision the matcher was supposed to make.
 *
 * `pages` is passed as part of a plain object — `edgeFetch` serialises it, and
 * the array must survive as JSON rather than being stringified here. A string
 * where an array is expected reads as an empty page list, which surfaces as
 * "nothing was extracted" rather than as an error.
 */
export async function processOcrPages(input: {
  documentId: string;
  pages: OcrPage[];
}): Promise<{
  status: string;
  resultCount: number;
  lineCount: number;
  averageConfidence: number;
  needsReview: number;
  message: string;
}> {
  return edgeFetch('ocr-process', {
    method: 'POST',
    body: { documentId: input.documentId, pages: input.pages },
  });
}

/** Magic-byte validation, mirroring the retired `lib/upload.ts`. */
export const ACCEPTED_UPLOAD_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'image/webp',
] as const;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Client-side pre-check.
 *
 * The server repeats all of this — a browser check is a courtesy that saves a
 * wasted upload, not a control. MIME type in particular is attacker-controlled,
 * so the Edge Function sniffs magic bytes rather than trusting what the browser
 * said.
 */
export function validateUploadFile(file: File): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`;
  }
  if (!(ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
    return 'Upload a JPEG, PNG, WebP or PDF mark sheet.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Signed URLs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A short-lived signed URL for an uploaded mark sheet.
 *
 * Replaces `GET /api/ocr/:id/file`, which streamed the bytes through the Worker.
 * Two reasons this is safe rather than a regression:
 *
 *  1. RLS on `ocr_documents` decides whether the caller may read the row at all.
 *  2. The bucket is private, so no URL is guessable and the signed one expires.
 *
 * The Edge Function re-checks the *assignment* scope before minting, because
 * Storage RLS cannot express "assigned to this section+subject".
 */
export async function getDocumentSignedUrl(documentId: string): Promise<string> {
  // Object, not a pre-stringified string — see `confirmOcrDocument`.
  const result = await edgeFetch<{ url: string }>('ocr-file-url', {
    method: 'POST',
    body: { documentId },
  });
  return result.url;
}

/* -------------------------------------------------------------------------- */
/* OCR documents                                                                */
/* -------------------------------------------------------------------------- */

export async function listOcrDocuments(params: ListParams): Promise<ListResponse<OcrDocument>> {
  const { page, pageSize, status, search, mine } = params;

  let q = getSupabase().from('v_ocr_documents').select('*', { count: 'exact' });

  if (status) q = q.eq('status', status);
  if (mine) q = q.eq('uploaded_by', mine as string);
  q = applySearch(q, orSearch(['original_filename', 'subject_name', 'exam_name'], search as string | undefined));

  return paginate<OcrDocument, typeof q>(q.order('created_at', { ascending: false }), {
    page: page as number,
    pageSize: pageSize as number,
  });
}

export interface OcrDocumentWithResults {
  document: OcrDocument;
  results: OcrResultRow[];
  breakdown: { high: number; medium: number; low: number };
}

export async function getOcrDocument(documentId: string): Promise<OcrDocumentWithResults> {
  const [docRes, rowsRes] = await Promise.all([
    getSupabase().from('v_ocr_documents').select('*').eq('id', documentId).maybeSingle(),
    getSupabase().from('v_ocr_results').select('*').eq('document_id', documentId).order('line_index'),
  ]);

  if (docRes.error) throw toQueryError(docRes.error);
  if (rowsRes.error) throw toQueryError(rowsRes.error);

  const results = camelMany<OcrResultRow>(rowsRes.data);

  return {
    document: camel<OcrDocument>(docRes.data)!,
    results,
    breakdown: {
      high: results.filter((r) => (r.confidence ?? 0) >= 0.9).length,
      medium: results.filter((r) => (r.confidence ?? 0) >= 0.7 && (r.confidence ?? 0) < 0.9).length,
      low: results.filter((r) => (r.confidence ?? 0) < 0.7).length,
    },
  };
}

/**
 * A correction to apply to extracted rows.
 *
 * The key is `id`, not `rowId`: `ocr_results` has no `row_id` column, and
 * PostgREST matches the objects in a bulk update against each row's primary key.
 * Sending `rowId` would both fail with PGRST204 and fail to target a single row,
 * updating nothing at all.
 */
export interface OcrResultCorrection {
  id: string;
  correctedMarks?: string | null;
  correctedStatus?: string | null;
  matchedStudentId?: string | null;
  verified?: boolean;
}

/**
 * Apply corrections to extracted rows.
 *
 * Narrowed to one document by `eq('document_id', …)`: `ocr_results.id` is a uuid
 * generated by Postgres and is not guessable, so the document filter is belt and
 * braces rather than the actual control. RLS is.
 */
export async function updateOcrResults(
  documentId: string,
  rows: OcrResultCorrection[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const { data, error } = await getSupabase()
    .from('ocr_results')
    .update(rows as unknown as Record<string, unknown>[])
    .eq('document_id', documentId)
    .select('id');

  if (error) throw toQueryError(error);
  return data?.length ?? 0;
}

/**
 * Turn confirmed OCR rows into draft marks.
 *
 * Calls the Edge Function rather than writing `marks` directly: confirming
 * touches many rows across two tables and must be atomic, and the confirmation
 * rules (verified-only, no ambiguous matches) are server logic.
 */
export async function confirmOcrDocument(
  documentId: string,
  markReviewed: boolean,
): Promise<{ created: number; updated: number; skipped: number; message: string }> {
  // The body is passed as an object, not `JSON.stringify(...)`. `edgeFetch`
  // serialises it itself; stringifying here double-encoded the payload, and
  // `readJson` in the function then returned a *string* rather than the object,
  // so `documentId` destructured to `undefined`.
  return edgeFetch('ocr-confirm', {
    method: 'POST',
    body: { documentId, markReviewed },
  });
}

/** Search students to resolve an ambiguous OCR match by hand. */
export async function searchStudentsForMatch(
  term: string,
  sectionId?: string,
): Promise<Array<{ id: string; studentNumber: string; admissionNumber: string | null; rollNumber: number | null; fullName: string }>> {
  if (!term.trim()) return [];

  let q = getSupabase().from('v_students').select('id, student_number, admission_number, roll_number, full_name');

  if (sectionId) q = q.eq('section_id', sectionId);

  q = /^\d+$/.test(term.trim())
    ? q.or(`student_number.ilike.%${term.trim()}%,admission_number.ilike.%${term.trim()}%,roll_number.eq.${Number(term.trim())}`)
    : applySearch(q, orSearch(['full_name'], term));

  const { data, error } = await q.limit(15).order('full_name');
  if (error) throw toQueryError(error);
  return camelMany(data as Record<string, unknown>[]);
}

/** Which OCR providers are configured. Booleans only — never credentials. */
/** What an OCR provider can and cannot do. Shown on the upload and settings screens. */
export interface OcrProviderCapabilities {
  boundingBoxes: boolean;
  multiPage: boolean;
  maxPages: number;
  maxFileBytes: number;
  formats: string[];
}

export interface OcrProviderInfo {
  name: string;
  /** Human label, e.g. "Google Cloud Vision". */
  label: string;
  /**
   * Whether this provider's credentials are present. Booleans only — the
   * function never returns a key, because confirming a live credential is itself
   * a small disclosure.
   */
  configured: boolean;
  capabilities: OcrProviderCapabilities;
  active: boolean;
}

export interface ProviderStatus {
  providers: OcrProviderInfo[];
  activeProvider: string;
  activeProviderLabel: string;
  /**
   * False when `OCR_PROVIDER` names a provider with no credentials. Worth
   * surfacing prominently: every upload will fail with a 503 until it is fixed.
   */
  activeProviderConfigured: boolean;
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  return edgeFetch('ocr-providers', { method: 'GET' });
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                      */
/* -------------------------------------------------------------------------- */

export async function listExports(params: ListParams): Promise<ListResponse<ExportJob>> {
  const { page, pageSize } = params;

  const q = getSupabase().from('export_jobs').select('*', { count: 'exact' });

  return paginate<ExportJob, typeof q>(q.order('created_at', { ascending: false }), {
    page: page as number,
    pageSize: pageSize as number,
  });
}

export async function requestExport(input: {
  kind: string;
  format: string;
  params?: Record<string, unknown>;
}): Promise<{ job: ExportJob; queued: boolean; message: string }> {
  return edgeFetch('export-generate', {
    method: 'POST',
    body: input,
  });
}

/** Signed URL for a completed export, or an inline download for small sets. */
export async function getExportDownloadUrl(jobId: string): Promise<string> {
  // Object, not a pre-stringified string — see `confirmOcrDocument`.
  const result = await edgeFetch<{ url: string; inline: boolean }>('export-download', {
    method: 'POST',
    body: { jobId },
  });
  return result.url;
}

/** CSV/XLSX of students matching the current filters. */
export async function downloadStudentExport(
  filters: Record<string, string | undefined>,
  format: 'csv' | 'xlsx',
): Promise<string> {
  // Routed through the standard export pipeline rather than a dedicated
  // endpoint: `export-generate` already supports every filter the students
  // page collects, records the job the administrator can audit, and shares
  // the same storage path everything else downloads from. A bespoke
  // `export-students` edge function once existed on the frontend but never on
  // the backend, so this button has never worked.
  const { job } = await requestExport({ kind: 'students', format, params: filters });
  return getExportDownloadUrl(job.id);
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse an uploaded student list and report what would happen.
 *
 * `classId` and `sectionId` are optional but should be supplied: a flat CSV
 * carries no section, so when a year has more than one section the function
 * refuses rather than filing students under an arbitrary one.
 */
export async function previewImport(
  file: File,
  academicYearId: string,
  target?: { classId?: string; sectionId?: string },
): Promise<ImportPreview> {
  const form = new FormData();
  form.append('file', file);
  form.append('academicYearId', academicYearId);
  if (target?.classId) form.append('classId', target.classId);
  if (target?.sectionId) form.append('sectionId', target.sectionId);

  return edgeFetch('import-preview', { method: 'POST', body: form });
}

export async function commitImport(
  batchId: string,
  target: { classId: string; sectionId: string },
  skipInvalidRows = true,
): Promise<ImportResult & { message: string }> {
  // Object, not a pre-stringified string — see `confirmOcrDocument`.
  return edgeFetch('import-commit', {
    method: 'POST',
    body: { batchId, ...target, skipInvalidRows },
  });
}

/**
 * The import template, fetched directly as a file.
 *
 * Not routed through `edgeFetch` + `downloadFromUrl` because this function
 * returns the CSV body itself rather than a signed URL — there is nothing to
 * store, and a one-shot file should not leave a copy in a bucket.
 */
export async function downloadImportTemplate(): Promise<void> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (!supabaseUrl || !anonKey) {
    throw new QueryError('NOT_CONFIGURED', 'Supabase is not configured.');
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/import-template`, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${await getEdgeToken()}`,
    },
  });

  if (!response.ok) {
    throw new QueryError('DOWNLOAD_FAILED', 'The template could not be downloaded.');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = 'student-import-template.csv';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/* -------------------------------------------------------------------------- */
/* Shared download helper                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Follow a signed URL and save it.
 *
 * A plain `<a download>` is not enough: the Supabase CDN does not always set a
 * filename, so the name the user ends up with is a bucket id. Fetching the blob
 * and setting `download` explicitly keeps the filename meaningful.
 */
export async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}.`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoked on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}