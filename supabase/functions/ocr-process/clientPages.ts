/**
 * Validation for a mark sheet recognised in the browser.
 *
 * ── Why this is a trust boundary ──────────────────────────────────────────────
 * Recognition normally runs client-side with Tesseract.js, so `ocr-process` is
 * handed words that a caller produced rather than words a vendor produced. This
 * module is the gate between those two situations, and everything downstream —
 * `parseMarkSheet`, `matchRow`, `replace_ocr_results` — is built on the guarantee
 * that only well-formed words and boxes ever reach it.
 *
 * ── What it does and does not decide ──────────────────────────────────────────
 * It normalises *geometry and text*. It does not decide anything about content:
 * no identifier, no name, no mark, no student. Those are derived downstream by
 * the parser and the matcher from the words themselves, which is why a caller
 * posting its own `matchedStudentId` has it ignored — the return type here is
 * `OcrPage[]`, a shape with nowhere to put that field, so the payload's version
 * is discarded by construction rather than by careful filtering.
 *
 * That is the load-bearing property of this file, and it is the reason it has its
 * own tests rather than being inlined into the request handler: a hole here would
 * let a caller attach a mark to a student the roster does not support.
 *
 * ── Kept dependency-free ──────────────────────────────────────────────────────
 * Deliberately imports nothing — not `../_shared/`, not `Deno`. The file runs on
 * the Edge runtime in production and under vitest in `supabase/tests/`, and the
 * only way to keep those two honest with each other is for there to be one copy of
 * the logic with no environment-specific code in it to separate.
 */

/** Ceilings on a browser-recognised payload. */
export const CLIENT_MAX_PAGES = 20;
export const CLIENT_MAX_WORDS_PER_PAGE = 4_000;
export const CLIENT_MAX_WORD_CHARS = 64;

/**
 * A single word as it appears on the sheet.
 *
 * `bbox` is in 0..1 page fractions, never pixels: `parseMarkSheet` groups rows by
 * comparing `bbox.y` across words, and that comparison must mean the same thing
 * for a phone photo and an A4 scan.
 */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { page: number; x: number; y: number; width: number; height: number };
}

export interface OcrPage {
  width: number;
  height: number;
  words: OcrWord[];
}

export type ClientPagesResult =
  | { pages: OcrPage[]; error: null }
  | { pages: null; error: string };

/**
 * Validate and normalise the pages a browser recognised.
 *
 * Returns `{ pages }` on success or `{ error }` with a message safe to show the
 * caller. The rules are conservative, and each one exists because of a specific
 * downstream symptom rather than as general tidiness:
 *
 *  - The shape must be right. A malformed body is a 400, not a crash.
 *  - Boxes are clamped to the page. A box outside 0..1 feeds `groupIntoLines`
 *    nonsense, and one whose far edge runs past 1 is written to `ocr_results`
 *    and drawn off the side of the sheet in review.
 *  - The page number is rewritten to the array index. The client's own `page`
 *    values are ignored so a caller cannot make two rows claim to be on
 *    different pages of a one-page sheet — the review screen's page-picker keys
 *    off this and would show phantom pages.
 *  - Text is length-capped and empty words dropped, which bounds both the insert
 *    and the `raw_text` column.
 *
 * An empty array is *not* an error: "this sheet has no text" is a real answer,
 * and the caller reports it distinctly from a failure.
 *
 * Nothing here is trusted for anything that becomes a mark: those fields are all
 * derived downstream by `parseMarkSheet` and `matchRow`.
 */
export function readClientPages(input: unknown): ClientPagesResult {
  if (!Array.isArray(input)) {
    return { pages: null, error: 'Recognised pages must be an array.' };
  }

  if (input.length === 0) {
    return { pages: [], error: null };
  }

  if (input.length > CLIENT_MAX_PAGES) {
    return {
      pages: null,
      error: `A mark sheet may have at most ${CLIENT_MAX_PAGES} pages; ${input.length} were sent.`,
    };
  }

  const pages: OcrPage[] = [];

  for (const [pageIndex, rawPage] of input.entries()) {
    if (rawPage === null || typeof rawPage !== 'object') {
      return { pages: null, error: `Page ${pageIndex + 1} is not a page.` };
    }

    const page = rawPage as { width?: unknown; height?: unknown; words?: unknown };
    const width = Number(page.width);
    const height = Number(page.height);

    // A zero dimension would make every x/width divide by zero into NaN, and NaN
    // silently defeats the `=== null` guards downstream. Refuse instead.
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return { pages: null, error: `Page ${pageIndex + 1} has an unusable size.` };
    }

    const rawWords = page.words;

    if (rawWords !== undefined && !Array.isArray(rawWords)) {
      return { pages: null, error: `Page ${pageIndex + 1} has a malformed word list.` };
    }

    const words: OcrWord[] = [];

    // Silently bounded rather than rejected. A legitimate mark sheet is a few
    // hundred words at most, so hitting this cap means a hostile payload, and
    // a hostile payload deserves to be neutralised quietly rather than answered
    // with information about where its own limits lie.
    for (const rawWord of (rawWords ?? []).slice(0, CLIENT_MAX_WORDS_PER_PAGE)) {
      const word = readClientWord(rawWord, pageIndex);

      if (word) words.push(word);
    }

    pages.push({ width, height, words });
  }

  return { pages, error: null };
}

function readClientWord(raw: unknown, pageIndex: number): OcrWord | null {
  if (raw === null || typeof raw !== 'object') return null;

  const word = raw as { text?: unknown; confidence?: unknown; bbox?: unknown };

  const text = typeof word.text === 'string' ? word.text.trim().slice(0, CLIENT_MAX_WORD_CHARS) : '';

  // Tesseract emits whitespace-only tokens around punctuation; keeping them
  // would let a row's name join with a stray space and lose its match.
  if (text === '') return null;

  if (word.bbox === null || typeof word.bbox !== 'object') return null;

  const box = word.bbox as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };

  // `Number(undefined)` is NaN and `Number(null)` is 0. The first is rejected
  // here; the second is accepted as "no offset", which is a sensible reading of
  // a null coordinate and stays inside the page after clamping.
  const x = Number(box.x);
  const y = Number(box.y);
  const boxWidth = Number(box.width);
  const boxHeight = Number(box.height);

  if (![x, y, boxWidth, boxHeight].every((value) => Number.isFinite(value))) return null;

  const confidence = Number(word.confidence);

  // Clamped first, then read back, so the box is inside the page in both senses
  // at once: each value in 0..1, *and* the far edge no further than 1. Clamping
  // the four independently permits `x + width > 1` — a word at x 0.9 with width
  // 1.0 describes a box ending at 1.9 — and `unionBox` then computes a right edge
  // past the page, which review draws as a box running off the side of the sheet.
  const clampedX = clamp01(x);
  const clampedY = clamp01(y);

  return {
    text,
    // Tesseract reports 0..100 while the pipeline wants 0..1. A caller sending
    // either scale is accepted: anything above 1 is read as a percentage, and a
    // missing or nonsensical confidence becomes 0, which puts the row in the
    // low-confidence band — the right place for "we do not know how sure this is".
    confidence: clamp01(Number.isFinite(confidence) ? (confidence > 1 ? confidence / 100 : confidence) : 0),
    bbox: {
      // Index-derived, not client-supplied — see the docstring above.
      page: pageIndex,
      x: clampedX,
      y: clampedY,
      width: clamp01(Math.min(boxWidth, 1 - clampedX)),
      height: clamp01(Math.min(boxHeight, 1 - clampedY)),
    },
  };
}

/**
 * Force a coordinate into 0..1.
 *
 * NaN is rejected before the range checks rather than after. `NaN < 0` and
 * `NaN > 1` are both false, so a naive clamp falls through and *returns* the NaN
 * — and this is the last gate before `groupIntoLines`, whose
 * `sort((a, b) => a.bbox.y - b.bbox.y)` gives implementation-defined ordering when
 * any comparison is NaN. The symptom would be rows in an arbitrary order with no
 * error anywhere, which is the worst thing to chase down from production.
 *
 * `readClientWord` already filters non-finite input, so this is defence in depth
 * rather than the sole check: a trust boundary should not depend on its caller
 * having remembered to pre-validate.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}
