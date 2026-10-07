import { enforceRateLimit, hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';
import {
  readClientPages,
  type OcrPage,
  type OcrWord,
} from './clientPages.ts';

/**
 * Extract text and marks from an uploaded mark sheet.
 *
 * Port of `ocrService.processDocument()` and the `ocr/` provider registry.
 *
 * Structure mirrors the retired implementation:
 *
 *   provider  → calls a vendor API and returns normalised pages of words + boxes
 *   parser    → groups words into lines and reads name / code / marks
 *   matcher   → resolves each line to a student on the roster, from the sheet's
 *               roll number and name only (never the student or admission number)
 *   persist   → writes `ocr_results` and updates the document's status
 *
 * ── On provider failure ───────────────────────────────────────────────────────
 * An unconfigured provider returns 503 rather than silently falling back to
 * "manual". That behaviour is preserved deliberately: a school whose Google Vision
 * key expired must be told, because the manual provider produces zero rows and
 * would otherwise look like "the scan was blank".
 *
 * ── Business Rule 1 ───────────────────────────────────────────────────────────
 * Nothing here writes to `marks`. Everything lands in `ocr_results` with
 * `verified = false`, and only `ocr-confirm` turns suggestions into marks.
 *
 * ── Client-side recognition ───────────────────────────────────────────────────
 * Recognition normally runs in the browser with Tesseract.js, and this function
 * is handed the words it read (`pages` in the request body). That makes the
 * request body attacker-controlled, which is the single most important thing to
 * understand about this endpoint:
 *
 *   Only the *words and their boxes* are accepted. Every value the system acts
 *   on — the detected identifier, the detected name, the mark, the student it
 *   resolves to, the confidence band — is derived below from those words by the
 *   parser and the matcher. A caller that posts its own `matchedStudentId` or
 *   `matchMethod` has those fields ignored outright, because `parseMarkSheet`
 *   and `matchRow` build fresh rows and never read them off the payload.
 *
 * So a malicious caller controls *what text the sheet appears to say*, which it
 * could equally do by photographing a different page — but it cannot attach a
 * mark to a student the roster does not support, and it cannot bypass the
 * ambiguity guard that refuses to guess.
 *
 * The provider path below is kept for the server-side vendors. When `pages` is
 * present neither is consulted, and no vendor credential is required.
 */

const REVIEW_THRESHOLD = 0.7;
const AUTO_ACCEPT_SCORE = 0.92;
const MIN_CANDIDATE_SCORE = 0.55;
const AMBIGUITY_MARGIN = 0.06;

// `OcrPage` / `OcrWord` and the `CLIENT_MAX_*` ceilings come from `./clientPages.ts`
// rather than being declared here. That module is the only definition of what a
// recognised page *is*, so the request handler, the providers below and the parser
// all see one shape. It is also the module `supabase/tests/` exercises, which only
// holds while there is exactly one copy of the validation logic to test.

interface Provider {
  name: string;
  isConfigured(): boolean;
  /**
   * The image bytes.
   *
   * Typed as `Uint8Array<ArrayBuffer>` because two providers hand these straight
   * to `fetch` as `BodyInit`, which rejects the `SharedArrayBuffer` case. The
   * bytes come from `Deno.readFile`, so they are always backed by a plain
   * `ArrayBuffer`; spelling that out keeps the annotation honest instead of
   * widening to a union that cannot actually occur.
   */
  extract(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<OcrPage[]>;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (
        !(await hasPermission(caller, 'ocr:review')) &&
        !(await hasPermission(caller, 'ocr:upload')) &&
        !(await hasPermission(caller, 'ocr:view_all'))
      ) {
        return fail('FORBIDDEN', 'You do not have permission to process mark sheets.', 403);
      }

      // Vendor OCR APIs are themselves rate-limited, so an unbounded caller here
      // would exhaust the school's quota and start failing for everyone.
      await enforceRateLimit(caller, 'ocrProcess');

      const { documentId, providerName, pages: rawPages } = await readJson<{
        documentId?: string;
        providerName?: string;
        pages?: unknown;
      }>(request);

      if (!documentId) {
        return fail('VALIDATION_ERROR', 'A document id is required.', 400);
      }

      const { data: document, error: docError } = await caller.supabase
        .from('ocr_documents')
        .select('id, uploaded_by, storage_bucket, storage_path, content_type, status, provider, section_id, academic_year_id')
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

      // Retry is only meaningful for a failed or stuck document.
      if (!['UPLOADED', 'QUEUED', 'FAILED', 'PROCESSING'].includes(document.status)) {
        return fail(
          'CONFLICT',
          `This document is ${document.status.toLowerCase()} and cannot be reprocessed.`,
          409,
        );
      }

      await caller.supabase
        .from('ocr_documents')
        .update({ status: 'PROCESSING', error_message: null, started_at: new Date().toISOString() })
        .eq('id', documentId);

      // Parse the browser's payload *before* the document is flipped to
      // PROCESSING, so a malformed request is a 400 on a document that is still
      // in its previous state rather than a document marked FAILED by a bad
      // body.
      const clientPages = rawPages === undefined ? null : readClientPages(rawPages);

      if (clientPages && clientPages.error) {
        return fail('VALIDATION_ERROR', clientPages.error, 400);
      }

      try {
        // When the browser recognised the sheet, no provider is consulted at all
        // — not even for configuration. That is the point: a school with no
        // vendor credential gets working OCR anyway.
        const provider = clientPages ? null : resolveProvider(providerName ?? document.provider);

        if (provider && !provider.isConfigured()) {
          // Not a silent fallback: this is the difference between "the scan was
          // blank" and "our credentials expired".
          await markFailed(caller.supabase, documentId, `The ${provider.name} provider is not configured.`);

          return fail(
            'SERVICE_UNAVAILABLE',
            `The ${provider.name} OCR provider is not configured. Ask an administrator to set the provider credentials.`,
            503,
          );
        }

        let pages: OcrPage[];

        if (clientPages) {
          pages = clientPages.pages;
        } else {
          const { data: file, error: fileError } = await caller.supabase.storage
            .from(document.storage_bucket ?? 'mark-sheets')
            .download(document.storage_path);

          if (fileError || !file) {
            await markFailed(caller.supabase, documentId, 'The uploaded file could not be read.');
            return fail('NOT_FOUND', 'The uploaded file could not be read.', 404);
          }

          const bytes = new Uint8Array(await file.arrayBuffer());
          pages = await provider!.extract(bytes, document.content_type);
        }

        if (pages.length === 0) {
          await markFailed(caller.supabase, documentId, 'No text was found in the document.');

          return fail(
            'OCR_NOT_COMPLETED',
            'No text could be read from that mark sheet. Try a clearer scan, or enter the marks by hand.',
            422,
          );
        }

        // The roster tells the matcher which roll numbers and names to expect,
        // which materially improves accuracy. Student and admission numbers are
        // deliberately not fetched — the sheet identifies a student by roll
        // number or name only, so anything else here would tempt the matcher
        // back into an identifier rule that no longer exists.
        const { data: roster } = await caller.supabase
          .from('v_students')
          .select('id, roll_number, full_name, normalized_name')
          .eq('section_id', document.section_id)
          .eq('academic_year_id', document.academic_year_id)
          .eq('status', 'active');

        const candidates = ((roster ?? []) as Array<{
          id: string;
          roll_number: number | null;
          full_name: string;
          normalized_name: string;
        }>).map((r) => ({
          id: r.id,
          rollNumber: r.roll_number,
          fullName: r.full_name,
          normalizedName: r.normalized_name,
        }));

        const lines = parseMarkSheet(pages);
        const matched = lines.map((line) => matchRow(line, candidates));

        const avgConfidence =
          matched.length > 0
            ? matched.reduce((sum, m) => sum + m.confidence, 0) / matched.length
            : 0;

        // `replace_ocr_results` deletes and reinserts in one transaction, so a
        // partially updated document is never observable.
        const inserted = await replaceResults(caller.supabase, documentId, matched, avgConfidence);

        return json({
          status: 'COMPLETED',
          resultCount: inserted,
          lineCount: matched.length,
          averageConfidence: Math.round(avgConfidence * 1000) / 1000,
          needsReview: matched.filter((m) => m.confidence < REVIEW_THRESHOLD).length,
          message: `${inserted} row(s) extracted. Review each one before confirming.`,
        });
      } catch (caught) {
        const message = (caught as Error)?.message ?? 'Unknown error';
        console.error('ocr processing failed', caught);
        await markFailed(caller.supabase, documentId, message);

        // A vendor rate limit or outage is retryable; a parse failure is not
        // something the user can fix by pressing the button again.
        const retryable = /rate|quota|429|5\d\d/i.test(message);
        return fail(
          retryable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
          retryable
            ? 'The OCR provider is busy. Try again in a few minutes.'
            : 'The mark sheet could not be processed.',
          retryable ? 503 : 500,
        );
      }
    }),
);

async function markFailed(
  supabase: { from: (t: string) => { update: (v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<unknown> } } },
  documentId: string,
  message: string,
): Promise<void> {
  await supabase
    .from('ocr_documents')
    .update({ status: 'FAILED', error_message: message.slice(0, 500), completed_at: new Date().toISOString() })
    .eq('id', documentId);
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveProvider(name: string): Provider {
  const requested = (name || 'manual').toLowerCase();

  switch (requested) {
    case 'google':
      return googleProvider;
    case 'azure':
      return azureProvider;
    case 'textract':
      return textractProvider;
    case 'manual':
    default:
      // Deliberately extracts nothing. This is the Business Rule 1 safety net:
      // with no working provider configured, nothing can be mistaken for a mark.
      return manualProvider;
  }
}

/** Base64 without a client-side polyfill dependency. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

const manualProvider: Provider = {
  name: 'manual',
  isConfigured: () => true,
  extract: async () => [],
};

const googleProvider: Provider = {
  name: 'google',
  isConfigured: () => Boolean(Deno.env.get('GOOGLE_VISION_API_KEY')),
  extract: async (bytes, contentType) => {
    const key = Deno.env.get('GOOGLE_VISION_API_KEY')!;

    const response = await fetch(
      `https://vision.googleapis.com/v1/documents:batchAnnotateFullText?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              image: { content: bytesToBase64(bytes) },
              features: [
                { type: 'DOCUMENT_OCR' },
                // Layout detection supplies the word bounding boxes that
                // DOCUMENT_OCR alone does not return.
                { type: 'LAYOUT_DETECTION' },
              ],
              imageContext: { languageHints: ['en'] },
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Google Vision returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      responses: Array<{
        fullTextAnnotation?: { pages?: Array<{ width?: number; height?: number; blocks?: unknown[] }> };
      }>;
    };

    const pages: OcrPage[] = [];

    for (const page of body.responses[0]?.fullTextAnnotation?.pages ?? []) {
      const words: OcrWord[] = [];

      for (const block of page.blocks ?? []) {
        const paragraphs = (block as { paragraphs?: Array<{ words?: unknown[] }> }).paragraphs ?? [];

        for (const paragraph of paragraphs) {
          for (const word of paragraph.words ?? []) {
            const w = word as {
              symbols?: Array<{ text?: string; boundingBox?: { x?: number; y?: number; width?: number; height?: number } }>;
              boundingBox?: { left?: number; top?: number; width?: number; height?: number };
            };

            const text = (w.symbols ?? []).map((s) => s.text ?? '').join('');
            if (!text) continue;

            const box = w.boundingBox;
            if (!box || !page.width || !page.height) continue;

            words.push({
              text,
              confidence: 1,
              bbox: {
                page: pages.length,
                x: (box.left ?? 0) / page.width,
                y: (box.top ?? 0) / page.height,
                width: (box.width ?? 0) / page.width,
                height: (box.height ?? 0) / page.height,
              },
            });
          }
        }
      }

      pages.push({ width: page.width ?? 1, height: page.height ?? 1, words });
    }

    return pages;
  },
};

const azureProvider: Provider = {
  name: 'azure',
  isConfigured: () =>
    Boolean(Deno.env.get('AZURE_VISION_ENDPOINT') && Deno.env.get('AZURE_VISION_KEY')),
  extract: async (bytes) => {
    const endpoint = Deno.env.get('AZURE_VISION_ENDPOINT')!.replace(/\/$/, '');
    const key = Deno.env.get('AZURE_VISION_KEY')!;

    // Raw binary rather than base64: Azure accepts it directly, and it saves a
    // third more upload bandwidth on a large multi-page scan.
    const response = await fetch(
      `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read&outputContentFormat=json`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      },
    );

    if (!response.ok) {
      throw new Error(`Azure Vision returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      pages?: Array<{
        width: number;
        height: number;
        words?: Array<{
          text: string;
          confidence: number;
          polygon: Array<{ x: number; y: number }>;
        }>;
      }>;
    };

    // Azure reports page size in pixels and polygons in absolute coordinates,
    // scaled by 1000 when the image exceeds that. Normalising to 0..1 here keeps
    // the parser provider-agnostic.
    return (body.pages ?? []).map((page, index) => {
      const scale = Math.max(page.width, page.height) > 1000 ? 1000 : 1;

      return {
        width: page.width / scale,
        height: page.height / scale,
        words: (page.words ?? []).map((word) => {
          const xs = word.polygon.map((p) => p.x);
          const ys = word.polygon.map((p) => p.y);
          const left = Math.min(...xs) / scale;
          const top = Math.min(...ys) / scale;

          return {
            text: word.text,
            confidence: word.confidence,
            bbox: {
              page: index,
              x: left / (page.width / scale),
              y: top / (page.height / scale),
              width: Math.max(...xs) / scale - left / (page.width / scale) + 1 / (page.width / scale),
              height: Math.max(...ys) / scale - top / (page.height / scale) + 1 / (page.height / scale),
            },
          };
        }),
      };
    });
  },
};

/**
 * AWS Textract.
 *
 * Detection only, and there is no SDK — the request is SigV4-signed by hand.
 * Textract also has no word bounding boxes, so every word gets a synthetic full-page
 * box; the parser tolerates that by grouping on text order rather than position.
 */
const textractProvider: Provider = {
  name: 'textract',
  isConfigured: () =>
    Boolean(
      Deno.env.get('AWS_TEXTRECT_ACCESS_KEY_ID') &&
      Deno.env.get('AWS_TEXTRECT_SECRET_ACCESS_KEY') &&
      Deno.env.get('AWS_REGION'),
    ),
  extract: async (bytes, contentType) => {
    const region = Deno.env.get('AWS_REGION')!;
    const host = `https://textract.${region}.amazonaws.com/`;

    // JPEG and PNG only. A PDF must be submitted to S3 first, which is a different
  // flow with different IAM requirements, so PDFs are rejected up front rather
  // than failing deep inside the vendor.
  if (contentType === 'application/pdf') {
    throw new Error('Textract cannot read a PDF directly. Re-upload as an image, or use another provider.');
  }

  const payload = JSON.stringify({ Document: { Bytes: bytesToBase64(bytes) } });

    const headers = await signRequest({
      method: 'POST',
      host,
      path: '/',
      region,
      service: 'textract',
      body: payload,
    });

    const response = await fetch(host, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-amz-json-1.1' },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Textract returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      Blocks?: Array<{ BlockType?: string; Text?: string }>;
    };

    const text = (body.Blocks ?? [])
      .filter((b) => b.BlockType === 'LINE' && b.Text)
      .map((b) => b.Text!)
      .join('\n');

    if (!text) return [];

    // One pseudo-page; each line becomes one synthetic word so the line-grouping
    // pass has something to work with.
    return [
      {
        width: 1,
        height: 1,
        words: text.split('\n').map((line, index) => ({
          text: line,
          confidence: 1,
          bbox: { page: 0, x: 0, y: index / text.split('\n').length, width: 1, height: 0.01 },
        })),
      },
    ];
  },
};

/**
 * Minimal SigV4 signer.
 *
 * Deliberately hand-rolled rather than pulling the AWS SDK: the SDK is far larger
 * than this one endpoint, and Edge Functions have a cold-start budget.
 */
async function signRequest(input: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  body: string;
}): Promise<Record<string, string>> {
  const accessKey = Deno.env.get('AWS_TEXTRECT_ACCESS_KEY_ID')!;
  const secretKey = Deno.env.get('AWS_TEXTRECT_SECRET_ACCESS_KEY')!;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(input.body);
  const host = input.host.replace(/^https?:\/\//, '');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    input.method,
    input.path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await hmac(
    await hmac(
      await hmac(
        await hmac(`AWS4${secretKey}`, dateStamp),
        input.region,
      ),
      input.service,
    ),
    'aws4_request',
  );

  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Parser — pure                                                                */
/* -------------------------------------------------------------------------- */

interface ParsedLine {
  lineIndex: number;
  rawText: string;
  detectedIdentifier: string | null;
  detectedName: string | null;
  detectedMarks: string | null;
  confidence: number;
  bboxPage: number;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
}

const MARKS_PATTERN = /^(\d{1,3}(?:\.\d)?)\s*(?:\/\s*(\d{1,3}(?:\.\d)?))?\s*%?$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\/\-]{1,20}$/;

const IGNORED_LINE = /^(total|sum|average|absent|present|signature|teacher|head|grade|class|section|page|marks?|date|total\s+marks)/i;

/** Group words into lines by vertical position, then read each line. */
function parseMarkSheet(pages: OcrPage[]): ParsedLine[] {
  const lines: ParsedLine[] = [];

  for (const page of pages) {
    // Textract yields one synthetic word per line already; anything else needs
    // geometric grouping.
    const grouped = groupIntoLines(page.words);

    for (const words of grouped) {
      const text = words.map((w) => w.text).join(' ').trim();
      if (!text || IGNORED_LINE.test(text)) continue;

      // A line with no digits cannot carry a mark, and treating it as one would
      // put noise into the review queue.
      if (!/\d/.test(text)) continue;

      const row = buildRow(words, text);
      lines.push({
        lineIndex: lines.length,
        rawText: text,
        detectedIdentifier: row.identifier,
        detectedName: row.name,
        detectedMarks: row.marks,
        confidence: row.confidence,
        bboxPage: row.page,
        bboxX: row.x,
        bboxY: row.y,
        bboxWidth: row.width,
        bboxHeight: row.height,
      });
    }
  }

  return lines;
}

/**
 * Cluster words by vertical midpoint.
 *
 * The tolerance is relative to page height, because an A4 scan and a phone photo
 * of the same sheet have very different pixel scales and a fixed pixel threshold
 * would group one correctly and the other not at all.
 */
function groupIntoLines(words: OcrWord[]): OcrWord[][] {
  if (words.length === 0) return [];

  const sorted = [...words].sort((a, b) => a.bbox.y - b.bbox.y);
  const centres = sorted.map((w) => w.bbox.y + w.bbox.height / 2);
  const spread = Math.max(...centres) - Math.min(...centres);

  if (spread === 0) return [sorted];

  const tolerance = spread * 0.006;
  const groups: OcrWord[][] = [];
  let current: OcrWord[] = [];
  let currentCentre = centres[0]!;

  sorted.forEach((word, index) => {
    const centre = centres[index]!;

    if (current.length === 0 || Math.abs(centre - currentCentre) <= tolerance) {
      current.push(word);
      currentCentre = current.length === 1 ? centre : (currentCentre + centre) / 2;
    } else {
      groups.push(current);
      current = [word];
      currentCentre = centre;
    }
  });

  if (current.length > 0) groups.push(current);

  // Left-to-right within each line, which is the reading order for a mark sheet.
  return groups.filter((group) => group.length > 0).map((group) =>
    [...group].sort((a, b) => a.bbox.x - b.bbox.x),
  );
}

function buildRow(words: OcrWord[], text: string): {
  identifier: string | null;
  name: string | null;
  marks: string | null;
  confidence: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  // The mark token is at the right-hand end of the line, so scan from the right.
  const reversed = [...words].reverse();
  let marks: string | null = null;
  let consumed = 0;

  for (const word of reversed) {
    const match = word.text.match(MARKS_PATTERN);
    if (match) {
      marks = match[0];
      consumed += 1;
      break;
    }
    // A stray non-numeric token at the end is not part of the mark.
    consumed += 1;
    if (consumed >= 2) break;
  }

  const remaining = words.slice(0, words.length - consumed);

  // The identifier is the last token that looks like a code rather than a name.
  let identifier: string | null = null;
  let nameTokens = remaining;

  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const token = remaining[i]!.text;
    if (IDENTIFIER_PATTERN.test(token) && !/^[A-Za-z]+$/.test(token)) {
      identifier = token;
      nameTokens = remaining.slice(0, i);
      break;
    }
  }

  const name = nameTokens.map((w) => w.text).join(' ').trim() || null;

  // Confidence blends how sure the vendor is with how complete the line is, then
  // is penalised when the mark looks implausible.
  const wordConfidence = words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
  const completeness = (identifier ? 0.5 : 0) + (name ? 0.25 : 0) + (marks ? 0.25 : 0);
  let confidence = wordConfidence * 0.7 + completeness * 0.3;

  const box = unionBox(words);

  return {
    identifier,
    name,
    marks,
    confidence: Math.max(0, Math.min(1, confidence)),
    page: words[0]?.bbox.page ?? 0,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
}

function unionBox(words: OcrWord[]): { x: number; y: number; width: number; height: number } {
  if (words.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  const left = Math.min(...words.map((w) => w.bbox.x));
  const top = Math.min(...words.map((w) => w.bbox.y));
  const right = Math.max(...words.map((w) => w.bbox.x + w.bbox.width));
  const bottom = Math.max(...words.map((w) => w.bbox.y + w.bbox.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/* -------------------------------------------------------------------------- */
/* Matcher — pure                                                               */
/* -------------------------------------------------------------------------- */

interface Candidate {
  id: string;
  rollNumber: number | null;
  fullName: string;
  normalizedName: string;
}

interface MatchedLine extends ParsedLine {
  matchedStudentId: string | null;
  matchMethod: 'roll_number' | 'normalized_name' | 'fuzzy_name' | 'manual' | 'none';
  matchConfidence: number | null;
  matchCandidates: string[] | null;
}

/**
 * Resolve a line to a student.
 *
 * Identity comes from the sheet's roll number and its name, in that order —
 * the student number and admission number are *not* identifiers here, even
 * when a scan happens to carry them. A row that reads as an alphanumeric code
 * the roster does not have a roll number for falls through to the name rules
 * rather than being force-fitted onto a student number.
 *
 * Never auto-assigns an ambiguous row: when the top two candidates are within
 * AMBIGUITY_MARGIN the result is `none` with the candidates attached, and a human
 * picks (Business Rule 1). Guessing here would put the wrong mark against a real
 * student's record.
 */
function matchRow(line: ParsedLine, candidates: Candidate[]): MatchedLine {
  const base: MatchedLine = {
    ...line,
    matchedStudentId: null,
    matchMethod: 'none',
    matchConfidence: null,
    matchCandidates: null,
  };

  if (candidates.length === 0) return base;

  // 1. Roll number.
  const numeric = line.detectedMarks === null ? null : Number(line.detectedMarks);
  if (line.detectedIdentifier && /^\d+$/.test(line.detectedIdentifier)) {
    const roll = Number(line.detectedIdentifier);
    const byRoll = candidates.find((c) => c.rollNumber === roll);
    if (byRoll) return { ...base, matchedStudentId: byRoll.id, matchMethod: 'roll_number', matchConfidence: 0.95 };
  }
  void numeric;

  // 2. Normalised name equality.
  if (line.detectedName) {
    const target = normalizeName(line.detectedName);
    const exact = candidates.find((c) => c.normalizedName === target);
    if (exact) return { ...base, matchedStudentId: exact.id, matchMethod: 'normalized_name', matchConfidence: 1 };
  }

  // 3. Fuzzy name, with an ambiguity check.
  if (line.detectedName) {
    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: nameSimilarity(normalizeName(line.detectedName!), candidate.normalizedName),
      }))
      .filter((entry) => entry.score >= MIN_CANDIDATE_SCORE)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

    if (best) {
      const runnerUp = scored[1];
      const ambiguous = runnerUp !== undefined && best.score - runnerUp.score < AMBIGUITY_MARGIN;

      if (ambiguous) {
        return {
          ...base,
          matchMethod: 'none',
          matchCandidates: scored.slice(0, 5).map((entry) => entry.candidate.id),
        };
      }

      // Above this, the match is good enough to pre-fill — but `verified` stays
      // false, so a human still confirms it before it becomes a mark.
      return {
        ...base,
        matchedStudentId: best.score >= AUTO_ACCEPT_SCORE ? best.candidate.id : null,
        matchMethod: 'fuzzy_name',
        matchConfidence: Math.round(best.score * 1000) / 1000,
        matchCandidates: scored.slice(0, 5).map((entry) => entry.candidate.id),
      };
    }
  }

  return base;
}

/**
 * Levenshtein similarity in 0..1.
 *
 * Ported from `nameSimilarity()` in @school/shared so the browser (which re-runs
 * matching when a teacher corrects a row) and this function agree.
 */
function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const distance = levenshtein(a, b, 3);
  const longest = Math.max(a.length, b.length);

  return longest === 0 ? 1 : Math.max(0, 1 - distance / longest);
}

function levenshtein(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }

    if (Math.min(...current) > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Lowercase and strip diacritics and punctuation.
 *
 * Mirrors `normalizeName()` in @school/shared and in the import-commit function.
 * Three copies is more than ideal; they exist because this code runs on Deno,
 * which cannot resolve the workspace package, and a divergence would silently
 * break matching after an import.
 */
function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Replace a document's results in one transaction.
 *
 * Delete-then-insert rather than a diff: a reprocessed document must not keep
 * rows from the previous attempt, and the function makes it atomic.
 */
async function replaceResults(
  supabase: {
    from: (t: string) => {
      update: (v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<unknown> };
      delete: () => { eq: (c: string, v: unknown) => PromiseLike<unknown> };
      insert: (v: unknown) => PromiseLike<unknown>;
    };
    rpc: (fn: string, args: unknown) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  documentId: string,
  matched: MatchedLine[],
  averageConfidence: number,
): Promise<number> {
  const { error } = await supabase.rpc('replace_ocr_results', {
    p_document_id: documentId,
    p_results: matched.map((line) => ({
      lineIndex: line.lineIndex,
      rawText: line.rawText,
      detectedIdentifier: line.detectedIdentifier,
      detectedName: line.detectedName,
      detectedMarks: line.detectedMarks,
      confidence: line.confidence,
      bboxPage: line.bboxPage,
      bboxX: line.bboxX,
      bboxY: line.bboxY,
      bboxWidth: line.bboxWidth,
      bboxHeight: line.bboxHeight,
      matchedStudentId: line.matchedStudentId,
      matchMethod: line.matchMethod,
      matchConfidence: line.matchConfidence,
      matchCandidates: line.matchCandidates,
    })),
  });

  if (error) {
    throw new Error(`replace_ocr_results failed: ${JSON.stringify(error)}`);
  }

  await supabase
    .from('ocr_documents')
    .update({
      status: 'COMPLETED',
      overall_confidence: Math.round(averageConfidence * 1000) / 1000,
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', documentId);

  return matched.length;
}