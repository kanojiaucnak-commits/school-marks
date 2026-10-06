import { describe, expect, it } from 'vitest';
import {
  CLIENT_MAX_PAGES,
  CLIENT_MAX_WORD_CHARS,
  CLIENT_MAX_WORDS_PER_PAGE,
  readClientPages,
} from '../../../supabase/functions/ocr-process/clientPages';

/**
 * The gate between "a browser said this" and "the database believes this".
 *
 * `ocr-process` is handed words a caller produced rather than words a vendor
 * produced, and everything downstream — `parseMarkSheet`, `matchRow`,
 * `replace_ocr_results` — assumes what it receives is well-formed and is only a
 * page of words. These tests pin that assumption, because it fails silently: a
 * NaN box makes `groupIntoLines`' sort produce arbitrary order, and a box that
 * overruns the page is drawn off the edge of the sheet in review, and neither
 * produces an error anywhere.
 *
 * The last test here is the one that actually justifies the module's existence.
 */

/** A word as `extract.ts` produces it: 0..1 fractions, confidence 0..1. */
function word(
  text: string,
  x: number,
  y: number,
  width = 0.05,
  height = 0.02,
  confidence = 0.9,
): Record<string, unknown> {
  return { text, confidence, bbox: { page: 0, x, y, width, height } };
}

function page(words: Record<string, unknown>[], size = 1000): Record<string, unknown> {
  return { width: size, height: size, words };
}

describe('readClientPages — acceptance', () => {
  it('accepts a normal mark sheet and preserves its geometry', () => {
    const result = readClientPages([page([word('STU001', 0.04, 0.1), word('Aarav', 0.1, 0.1)])]);

    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0]!.words.map((w) => w.text)).toEqual(['STU001', 'Aarav']);
    expect(result.pages![0]!.words[0]!.bbox).toEqual({
      page: 0,
      x: 0.04,
      y: 0.1,
      width: 0.05,
      height: 0.02,
    });
  });

  it('treats an empty page list as "no text found", not as an error', () => {
    // A blank sheet is a legitimate result the UI must be able to distinguish
    // from a failure — it is what the "enter the marks by hand" path keys off.
    expect(readClientPages([])).toEqual({ pages: [], error: null });
  });

  it('reports a malformed payload as a message rather than throwing', () => {
    // This runs inside an HTTP handler; a throw becomes a 500 with a stack trace
    // instead of the 400 the caller can act on.
    const result = readClientPages({ words: [] });
    expect(result.pages).toBeNull();
    expect(result.error).toBe('Recognised pages must be an array.');
  });
});

describe('readClientPages — page and word limits', () => {
  it('rejects more than CLIENT_MAX_PAGES pages, saying how many were sent', () => {
    const result = readClientPages(Array.from({ length: CLIENT_MAX_PAGES + 1 }, () => page([])));

    expect(result.pages).toBeNull();
    expect(result.error).toContain(String(CLIENT_MAX_PAGES));
    // The cap is 20 on both sides. If the browser is ever allowed to send more
    // than the server accepts, a legitimate long PDF fails with a confusing
    // message about its own upload, so the two numbers are worth pinning apart.
    expect(CLIENT_MAX_PAGES).toBe(20);
  });

  it('accepts exactly the maximum, so the limit is not off by one', () => {
    const result = readClientPages(Array.from({ length: CLIENT_MAX_PAGES }, () => page([])));

    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(CLIENT_MAX_PAGES);
  });

  it('caps the word count per page without failing the whole page', () => {
    // A hostile payload is neutralised quietly rather than answered with detail
    // about where its own limits lie, and the words that survive are still valid.
    const many = Array.from({ length: CLIENT_MAX_WORDS_PER_PAGE + 500 }, (_, i) =>
      word(`w${i}`, 0.1, 0.1),
    );

    const result = readClientPages([page(many)]);

    expect(result.error).toBeNull();
    expect(result.pages![0]!.words).toHaveLength(CLIENT_MAX_WORDS_PER_PAGE);
  });

  it('rejects a page whose dimensions are unusable', () => {
    // Division by a zero dimension is how NaN enters the coordinate space, and
    // NaN defeats the `=== null` guards downstream rather than raising.
    for (const bad of [0, -10, Number.NaN, 'wide', undefined, null]) {
      const result = readClientPages([{ ...page([]), width: bad }]);

      expect(result.pages, `width ${String(bad)} should be refused`).toBeNull();
      expect(result.error).toContain('unusable size');
    }

    expect(readClientPages([{ ...page([]), height: Number.NaN }]).pages).toBeNull();
  });

  it('rejects a page whose word list is not an array', () => {
    const result = readClientPages([{ width: 100, height: 100, words: 'not a list' }]);

    expect(result.pages).toBeNull();
    expect(result.error).toContain('malformed word list');
  });

  it('treats a missing word list as empty', () => {
    // A page with no `words` key is how a provider reports "nothing on this
    // sheet"; refusing it would make a blank page look like a bad payload.
    const result = readClientPages([{ width: 100, height: 100 }]);

    expect(result.error).toBeNull();
    expect(result.pages![0]!.words).toEqual([]);
  });
});

describe('readClientPages — boxes', () => {
  it('never lets a box extend past the page edge', () => {
    // `x` and `width` clamped independently allow x 0.9 + width 1.0 to describe a
    // box ending at 1.9. `unionBox` then writes `bbox_width > 1` to `ocr_results`
    // and the review screen draws it running off the side of the sheet.
    const result = readClientPages([page([word('Edge', 0.9, 0.85, 1, 1)])]);

    const box = result.pages![0]!.words[0]!.bbox;

    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
  });

  it('clamps out-of-range coordinates into the page', () => {
    const result = readClientPages([page([word('Outside', -0.4, 1.7, 5, 5)])]);

    const box = result.pages![0]!.words[0]!.bbox;

    expect(box.x).toBe(0);
    expect(box.y).toBe(1);
    // Each size is capped by whatever space is left after its origin, so the box
    // is anchored where it landed and cannot overrun: x 0 has the whole width
    // available, y 1 has none.
    expect(box.width).toBe(1);
    expect(box.height).toBe(0);
    // Above all: finite. `groupIntoLines` sorts on `bbox.y`, and a NaN there
    // gives implementation-defined ordering with no error raised anywhere.
    expect(Number.isFinite(box.y)).toBe(true);
  });

  it('drops words with non-finite coordinates instead of propagating NaN', () => {
    const result = readClientPages([
      page([
        word('Good', 0.1, 0.1),
        { text: 'NaNBox', confidence: 0.9, bbox: { page: 0, x: Number.NaN, y: 0, width: 1, height: 1 } },
        { text: 'NoBox', confidence: 0.9 },
        { text: 'NullBox', confidence: 0.9, bbox: null },
      ]),
    ]);

    expect(result.error).toBeNull();
    expect(result.pages![0]!.words.map((w) => w.text)).toEqual(['Good']);
  });

  it('leaves every coordinate that survives within 0..1', () => {
    const inputs = [
      [word('a', -9, -9, -9, -9)],
      [word('b', 2, 2, 2, 2)],
      [word('c', 0.5, 0.5, 0.4, 0.4)],
      [word('d', 1, 1, 0, 0)],
    ];

    for (const words of inputs) {
      const box = readClientPages([page(words)]).pages![0]!.words[0]!.bbox;

      for (const value of [box.x, box.y, box.width, box.height]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('readClientPages — text and confidence', () => {
  it('normalises Tesseract confidence from 0..100 to 0..1', () => {
    // The parser blends this into a 0..1 band and picks a threshold from it. A
    // raw 92 would pin every row to the top band and hide the ones needing a
    // second look, which is exactly what the review screen exists to surface.
    const result = readClientPages([page([{ ...word('x', 0.1, 0.1), confidence: 92 }])]);

    expect(result.pages![0]!.words[0]!.confidence).toBeCloseTo(0.92, 5);
  });

  it('clamps nonsense confidence into the low band rather than letting it through', () => {
    for (const [given, expected] of [
      [-5, 0],
      [0, 0],
      [0.5, 0.5],
      [1, 1],
      [100, 1],
      [1e9, 1],
      [Number.NaN, 0],
      [undefined, 0],
    ] as const) {
      const result = readClientPages([
        page([{ ...word('x', 0.1, 0.1), confidence: given as number }]),
      ]);

      const confidence = result.pages![0]!.words[0]!.confidence;

      expect(Number.isFinite(confidence), `${String(given)} must stay finite`).toBe(true);
      expect(confidence).toBeCloseTo(expected, 5);
    }
  });

  it('trims, drops empty words, and caps length', () => {
    const result = readClientPages([
      page([
        word('   ', 0.1, 0.1),
        word('', 0.2, 0.1),
        { text: '   ', confidence: 0.9 },
        word('A'.repeat(CLIENT_MAX_WORD_CHARS + 40), 0.3, 0.1),
        { confidence: 0.9, bbox: { x: 0.4, y: 0.1, width: 0.1, height: 0.1 } },
      ]),
    ]);

    const texts = result.pages![0]!.words.map((w) => w.text);

    // Dropped: whitespace-only, empty, and a missing `text` entirely.
    expect(texts).toHaveLength(1);
    expect(texts[0]!.length).toBe(CLIENT_MAX_WORD_CHARS);
  });
});

describe('readClientPages — untrusted fields', () => {
  it('discards any field other than text, confidence and bbox', () => {
    // This is the guarantee the rest of `ocr-process` rests on. A caller may
    // freely choose *what the sheet says* — it could equally have photographed a
    // different page — but it must not be able to hand in a *decision*. The
    // return type has nowhere to put these, so they are dropped by construction
    // rather than by remembering to filter them out.
    const result = readClientPages([
      page([
        {
          text: 'STU001',
          confidence: 0.95,
          bbox: { page: 0, x: 0.1, y: 0.1, width: 0.05, height: 0.02 },
          matchedStudentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          matchMethod: 'exact',
          matchConfidence: 1,
          detectedMarks: 100,
          verified: true,
        },
      ]),
    ]);

    const accepted = result.pages![0]!.words[0]! as Record<string, unknown>;

    expect(Object.keys(accepted).sort()).toEqual(['bbox', 'confidence', 'text']);
    expect(accepted.matchedStudentId).toBeUndefined();
    expect(accepted.detectedMarks).toBeUndefined();
  });

  it('rejects any bbox field that is not a finite number', () => {
    const result = readClientPages([
      page([
        { text: 'Bad', confidence: 0.9, bbox: { x: '0.1', y: 0.1, width: 0.1, height: 0.1 } },
      ]),
    ]);

    // A string coordinate parses via `Number()` to a real number, so it is kept;
    // what must never survive is `undefined` or `Infinity`, which become NaN or
    // an unbounded box. `'0.1'` is therefore accepted and normalised to 0.1.
    expect(result.pages![0]!.words[0]!.bbox.x).toBeCloseTo(0.1, 5);

    const poisoned = readClientPages([
      page([{ text: 'Bad', confidence: 0.9, bbox: { x: {}, y: 0.1, width: 0.1, height: 0.1 } }]),
    ]);

    expect(poisoned.pages![0]!.words).toEqual([]);
  });

  it('rewrites the page number to the array index', () => {
    // The review screen's page-picker and its rendered viewer key off `bbox.page`.
    // Accepting the client's value would let a caller invent phantom pages or
    // scatter one sheet's rows across several.
    const result = readClientPages([
      page([word('P', 0.1, 0.1), { ...word('P', 0.2, 0.1), bbox: { page: 7, x: 0.2, y: 0.1, width: 0.1, height: 0.1 } }]),
      page([word('Q', 0.1, 0.1)]),
    ]);

    expect(result.pages![0]!.words.map((w) => w.bbox.page)).toEqual([0, 0]);
    expect(result.pages![1]!.words.map((w) => w.bbox.page)).toEqual([1]);
  });
});
