import { describe, expect, it } from 'vitest';
import { readWords, toOcrWords, type RawWord } from './extract';

/**
 * Regression tests for the two places this module can fail silently.
 *
 * Neither throws when it goes wrong. A missed word is a missing mark row; a NaN
 * box is a word the parser drops during line grouping. Both surface as "the scan
 * was blank", which is indistinguishable from a bad photograph and sends
 * whoever is debugging it to the wrong place entirely. So the contract with
 * tesseract.js is pinned here rather than trusted.
 */

/** A word as tesseract reports it: pixel box, confidence 0..100. */
function word(text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): RawWord {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

/** A recognition result in the shape tesseract.js v7 actually returns. */
function nestedResult(words: RawWord[]) {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              { words: [words[0]!, words[1]!] },
              { words: [words[2]!] },
            ],
          },
        ],
      },
    ],
  };
}

describe('readWords', () => {
  it('finds words nested under blocks → paragraphs → lines', () => {
    // This is the only shape tesseract.js v7 produces. Reaching for `data.words`
    // here returns undefined, so the walk has to be exactly this deep.
    const data = nestedResult([
      word('STU001', 0, 0, 40, 10),
      word('Aarav', 50, 0, 90, 10),
      word('88', 95, 0, 110, 10),
    ]);

    expect(readWords(data).map((w) => w.text)).toEqual(['STU001', 'Aarav', '88']);
  });

  it('still reads a flat `words` array if a version restores it', () => {
    const flat = { words: [word('Solo', 1, 1, 2, 2)] };

    expect(readWords(flat).map((w) => w.text)).toEqual(['Solo']);
  });

  it('prefers the flat array when both are present', () => {
    // Defensive rather than incidental: if a future version adds `words` back
    // alongside `blocks`, reading it twice would duplicate every row.
    const both = { words: [word('Once', 0, 0, 1, 1)], ...nestedResult([word('Twice', 0, 0, 1, 1)]) };

    expect(readWords(both).map((w) => w.text)).toEqual(['Once']);
  });

  it('returns nothing rather than throwing on an empty page', () => {
    // A genuinely blank sheet is a real answer the caller must be able to act on.
    expect(readWords({ blocks: [{ paragraphs: [{ lines: [] }] }] })).toEqual([]);
    expect(readWords({ blocks: [] })).toEqual([]);
    expect(readWords({ blocks: null })).toEqual([]);
  });

  it('survives missing intermediate levels', () => {
    // Tesseract omits paragraphs on some layouts rather than emitting empties.
    expect(readWords({ blocks: [{}] })).toEqual([]);
    expect(readWords({ blocks: [{ paragraphs: [{}] }] })).toEqual([]);
    expect(readWords({ blocks: [{ paragraphs: [{ lines: [{}] }] }] })).toEqual([]);
  });

  it.each([[null], [undefined], ['not an object'], [42], [[]]])(
    'returns an empty list for %p',
    (input) => {
      expect(readWords(input)).toEqual([]);
    },
  );
});

describe('toOcrWords', () => {
  it('normalises pixel boxes into 0..1 page fractions', () => {
    // 200×100 page: a word at x 20..60, y 10..20 is x 0.1..0.3, y 0.1..0.2.
    const [out] = toOcrWords([word('Hi', 20, 10, 60, 20)], 0, 200, 100);

    expect(out).toMatchObject({
      text: 'Hi',
      confidence: 0.9,
      bbox: { page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    });
  });

  it('divides confidence by 100', () => {
    // The parser blends this into a 0..1 band; passing 92 through raw would pin
    // every row to the top confidence band and hide the ones that need checking.
    const [out] = toOcrWords([word('Hi', 0, 0, 1, 1, 92)], 0, 100, 100);

    expect(out!.confidence).toBeCloseTo(0.92, 5);
  });

  it('clamps boxes to the page', () => {
    // A box past the edge would sort to the wrong position and split a row in
    // two, so the clamp is load-bearing for line grouping, not cosmetic.
    const [out] = toOcrWords([word('Edge', -30, -30, 400, 400)], 0, 200, 200);

    expect(out!.bbox).toEqual({ page: 0, x: 0, y: 0, width: 1, height: 1 });
  });

  it('never emits NaN, which would silently drop a word from every line group', () => {
    // `Math.min(...nan)` is NaN, and `centre - currentCentre <= tolerance` is
    // false for NaN, so the word joins no group at all. The mark disappears.
    const malformed = [
      { text: 'NoBox', confidence: 80 } as RawWord,
      { text: 'BadBox', confidence: 80, bbox: { x0: Number.NaN, y0: 0, x1: 10, y1: 10 } },
      word('Good', 0, 0, 10, 10),
    ];

    const out = toOcrWords(malformed, 0, 100, 100);

    expect(out.map((w) => w.text)).toEqual(['BadBox', 'Good']);
    for (const entry of out) {
      for (const value of [
        entry.confidence,
        entry.bbox.x,
        entry.bbox.y,
        entry.bbox.width,
        entry.bbox.height,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('treats an inverted box as zero-height rather than negative', () => {
    const [out] = toOcrWords([word('Backwards', 50, 50, 20, 20)], 0, 100, 100);

    expect(out!.bbox.width).toBe(0);
    expect(out!.bbox.height).toBe(0);
  });

  it('drops blank and boxless words rather than emitting unusable rows', () => {
    const out = toOcrWords(
      [word('   ', 0, 0, 10, 10), { text: 'NoBox' } as RawWord, word('Real', 0, 0, 5, 5)],
      0,
      100,
      100,
    );

    expect(out.map((w) => w.text)).toEqual(['Real']);
  });

  it('carries the page index through', () => {
    // The review screen's document viewer maps this back to a rendered page.
    const out = toOcrWords([word('P', 0, 0, 5, 5)], 4, 100, 100);

    expect(out[0]!.bbox.page).toBe(4);
  });
});