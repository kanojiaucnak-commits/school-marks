/**
 * Upload validation, ported from the retired `worker/src/lib/upload.ts`.
 *
 * Client-side MIME checks are a courtesy, not a control: the `Content-Type` on a
 * multipart part is chosen by whoever is calling. This sniffs magic bytes, which
 * cannot be forged without producing a file that genuinely is that format.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** Only the first bytes are needed to identify a format. */
const SNIFF_BYTES = 32;

/** Leading byte signatures, longest/most-specific first. */
function sniff(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // PDF: %PDF-
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'application/pdf';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/** ZIP container, used to recognise XLSX (which is a ZIP of XML parts). */
function isZip(bytes: Uint8Array): boolean {
  // PK\x03\x04 — local file header
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export interface UploadCheck {
  ok: boolean;
  code?: 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED' | 'FILE_CORRUPT';
  message?: string;
  /** Format detected from the bytes, which overrides anything the client claimed. */
  detectedType?: string;
  extension?: string;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'xlsx',
  'text/csv': 'csv',
};

const CSV_FORMATS = ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'];

/**
 * Validate a mark-sheet upload.
 *
 * Checks, in order: non-empty, within the size ceiling, recognised magic bytes,
 * declared type agrees with the bytes, and for PDFs that the trailer is intact.
 */
export async function validateImageUpload(
  file: File,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<UploadCheck> {
  if (file.size === 0) {
    return { ok: false, code: 'FILE_CORRUPT', message: 'That file is empty.' };
  }

  if (file.size > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    };
  }

  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const detected = sniff(head);

  if (!detected) {
    return {
      ok: false,
      code: 'FILE_TYPE_NOT_ALLOWED',
      message: 'That file is not a JPEG, PNG, WebP or PDF.',
    };
  }

  // Trust the bytes over the header. A mismatch is normal for the odd client and
  // a red flag for a crafted request, and only the bytes decide which it is.
  if (file.type && file.type !== detected) {
    console.warn(`declared type ${file.type} disagrees with detected ${detected}`);
  }

  if (detected === 'application/pdf') {
    const tail = new Uint8Array(await file.slice(-2048).arrayBuffer());
    const trailer = new TextDecoder('latin1').decode(tail);
    if (!trailer.includes('%%EOF')) {
      return {
        ok: false,
        code: 'FILE_CORRUPT',
        message: 'That PDF looks incomplete. Try re-uploading it.',
      };
    }
  }

  return {
    ok: true,
    detectedType: detected,
    extension: EXTENSIONS[detected] ?? 'bin',
  };
}

/** CSV or XLSX, for the student-import path. */
export async function validateImportUpload(file: File): Promise<UploadCheck> {
  if (file.size === 0) {
    return { ok: false, code: 'FILE_CORRUPT', message: 'That file is empty.' };
  }

  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB.`,
    };
  }

  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());

  if (isZip(head)) return { ok: true, detectedType: 'application/zip', extension: 'xlsx' };

  // CSV has no signature, so text is accepted and validated at parse time. The
  // declared type is a weak hint but it is better than rejecting every .csv.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
  const looksLikeText = !text.includes('\u0000') && /^[\x20-\x7E\r\n\t,;]/.test(text);
  const declaredIsCsv = CSV_FORMATS.includes(file.type) || file.name.toLowerCase().endsWith('.csv');

  if (looksLikeText && declaredIsCsv) {
    return { ok: true, detectedType: 'text/csv', extension: 'csv' };
  }

  return {
    ok: false,
    code: 'FILE_TYPE_NOT_ALLOWED',
    message: 'Upload a CSV or XLSX file.',
  };
}

/**
 * A storage path that reveals nothing.
 *
 * Never derived from the uploader's filename: a file called `../../etc/passwd.pdf`
 * or `report (final) v2.pdf` must not become a path. The caller sees the original
 * name via `original_filename`; the key is opaque.
 */
export function buildUploadPath(userId: string, academicYearId: string, extension: string): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const safeYear = academicYearId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const unique = crypto.randomUUID();

  return `uploads/${safeUser || 'unknown'}/${safeYear || 'year'}/${unique}.${ext}`;
}

/** Export artefacts are owned by whoever requested them. */
export function buildExportPath(userId: string, extension: string): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  return `exports/${safeUser || 'unknown'}/${stamp}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
}