/**
 * Client-side OCR recognition with Tesseract.js.
 *
 * ── Why the browser ───────────────────────────────────────────────────────────
 * Recognition runs here, not in an Edge Function, for two reasons:
 *
 *  1. The uploaded bytes never leave the teacher's machine a second time. The
 *    file is already sent to `ocr-upload` to be filed in a private bucket, so the
 *     teacher can still open the original later — but nothing new leaves the
 *     device.
 *  2. No vendor key is needed. The previous provider list (Google / Azure /
 *     Textract) meant OCR was dead on arrival for any school that had not bought
 *     a cloud credential: `OCR_PROVIDER` defaulted to `manual`, which extracts
 *     nothing, so every upload "succeeded" with zero rows.
 *
 * ── What is still server-side ────────────────────────────────────────────────
 * Only *recognition* is here. Grouping words into rows, reading the name and
 * identifier out of each row, and resolving those against the section roster all
 * stay in `ocr-process`: the roster is RLS-protected and the writes must be
 * atomic. The browser's job ends at "here are the words and where they are".
 *
 * ── Normalisation ────────────────────────────────────────────────────────────
 * `parseMarkSheet` expects `bbox` in 0..1 page fractions so the parser is
 * provider-agnostic and a phone photo and an A4 scan group lines the same way.
 * Tesseract reports pixels, so every box is divided through here, once.
 */

/* -------------------------------------------------------------------------- */
/* Shapes — mirrors the `OcrPage` / `OcrWord` the Edge Function accepts       */
/* -------------------------------------------------------------------------- */

export interface OcrWord {
  text: string;
  /** Tesseract reports 0..100; the pipeline wants 0..1. */
  confidence: number;
  bbox: { page: number; x: number; y: number; width: number; height: number };
}

export interface OcrPage {
  width: number;
  height: number;
  words: OcrWord[];
}

/** Coarse progress for the upload screen. Stage names are user-facing. */
export type OcrStage = 'loading' | 'reading' | 'parsing';

export interface OcrProgress {
  stage: OcrStage;
  /**
   * 0..1, or `null` when the step has no countable progress.
   *
   * `null` is load-bearing rather than a placeholder. Two real steps are
   * indeterminate — the one-off OCR engine download and the match round trip —
   * and rendering either as 0% reads as a hang. `ScanProgressPanel` switches to a
   * busy treatment when it sees `null`.
   */
  fraction: number | null;
  /** e.g. "Downloading the OCR engine (first run only)". */
  message: string;
  /** Which page of N, when known. */
  page?: { current: number; total: number };
}

export interface ExtractOptions {
  /** Called as recognition advances. */
  onProgress?: (progress: OcrProgress) => void;
  /** Cancellation between pages. Checked before each page is recognised. */
  signal?: AbortSignal;
  /**
   * Tesseract language pack(s). `eng` covers the sheet; add more for a
   * multilingual roll.
   */
  langs?: string;
  /**
   * Hard cap on pages read from a PDF.
   *
   * A 200-page PDF at ~4s a page is 13 minutes of main-thread-adjacent WASM on
   * the teacher's laptop, which reads as a hang. 20 covers every realistic mark
   * sheet set and the cap is announced in the UI rather than applied silently.
   */
  maxPages?: number;
  /**
   * Filename, when the blob has none.
   *
   * Only consulted for files too small to sniff. A blob from `fetch` has no
   * `name`, and the format fallback needs something to go on.
   */
  nameHint?: string;
}

/** Dense enough for a mark sheet; caps OCR time on a phone photo. */
const RENDER_SCALE = 2;

const DEFAULT_MAX_PAGES = 20;

/* -------------------------------------------------------------------------- */
/* Worker lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One worker for the app's lifetime, keyed by language pack.
 *
 * `createWorker` downloads ~10 MB of WASM core plus the traineddata for the
 * language. Doing that per upload would make every upload feel broken, so the
 * worker is memoised. `terminate` is deliberately *not* called after a document:
 * the next upload is usually seconds away, and paying the cold start twice in a
 * row is the worst of both.
 */
const workers = new Map<string, Promise<TesseractWorker>>();

/**
 * Only the surface used here.
 *
 * Spelled out rather than importing tesseract.js's own types, because the shape
 * that matters — where the words live inside a recognition result — differs
 * between major versions and is the single thing most likely to break silently.
 * See `readWords` for the traversal this is built around.
 */
type TesseractWorker = {
  recognize: (
    image: Blob | HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ) => Promise<{ data?: unknown }>;
  terminate: () => Promise<unknown>;
};

async function getWorker(
  langs: string,
  onProgress?: (progress: OcrProgress) => void,
): Promise<TesseractWorker> {
  const key = langs;
  const existing = workers.get(key);

  if (existing) return existing;

  const created = (async () => {
    onProgress?.({
      stage: 'loading',
      fraction: null,
      message: 'Loading the OCR engine. This happens once, then it is cached.',
    });

    const { createWorker } = await import('tesseract.js');

    // `legacyCore: false` selects the LSTM-only core: smaller download, no
    // tessdata fallbacks to chase, and it is the accurate path for printed text
    // like a mark sheet. `createWorker(langs, oem, options)` is the v7 signature.
    const worker = (await createWorker(langs, 1, {
      legacyCore: false,
      // Progress here is about a multi-megabyte download, which is the slowest
      // part of a first run, so it is worth reporting rather than swallowing.
      logger: (message: { status: string; progress: number }) => {
        if (message.status === 'recognizing text' || message.status === 'loading language traineddata') {
          return;
        }
        onProgress?.({
          stage: 'loading',
          fraction: Number.isFinite(message.progress) ? message.progress : null,
          message: 'Loading the OCR engine…',
        });
      },
    })) as unknown as TesseractWorker;

    onProgress?.({
      stage: 'loading',
      fraction: 1,
      message: 'OCR engine ready.',
    });

    return worker;
  })();

  workers.set(key, created);

  // A failed load must not poison the cache: drop it so the next attempt
  // re-downloads rather than replaying the same rejection forever.
  created.catch(() => {
    if (workers.get(key) === created) workers.delete(key);
  });

  return created;
}

/**
 * Release the cached worker.
 *
 * Not called by the app, deliberately. A Tesseract worker is a web worker holding
 * its own copy of the recogniser, and the memoised one is what makes the second
 * upload of a session fast — tearing it down between documents would re-download
 * the engine every time, which is the single most expensive thing this module
 * does. Browsers reclaim workers on navigation and on tab close, so the lifetime
 * that matters is already handled without this.
 *
 * Kept exported for the case that is not covered by that: a caller that has
 * finished with OCR for good in a long-lived session — a kiosk tablet that has
 * been reading sheets for six hours, where the held WASM is worth reclaiming.
 */
export async function terminateOcr(): Promise<void> {
  const pending = [...workers.values()];
  workers.clear();
  await Promise.all(
    pending.map(async (worker) => {
      try {
        (await worker).terminate();
      } catch {
        // Nothing useful to do: the page is going away either way.
      }
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read a mark sheet and return normalised pages of words.
 *
 * Takes a `Blob` rather than a `File` because retry re-reads the stored upload,
 * which arrives from `fetch` as a bare blob with no filename. Format detection
 * therefore leans on the MIME type and only consults `nameHint` when the type is
 * missing or the unhelpful `application/octet-stream` that some storage
 * responses carry.
 *
 * An empty array means "no text found", which is a real answer the caller must
 * distinguish from a crash — the review screen offers manual entry for it.
 */
export async function extractPages(
  file: Blob,
  options: ExtractOptions = {},
): Promise<OcrPage[]> {
  const {
    onProgress,
    signal,
    langs = 'eng',
    maxPages = DEFAULT_MAX_PAGES,
    nameHint,
  } = options;

  throwIfAborted(signal);

  if (await isPdf(file, nameHint)) {
    return extractFromPdf(file, { onProgress, signal, langs, maxPages });
  }

  onProgress?.({ stage: 'reading', fraction: null, message: 'Reading the image…', page: { current: 1, total: 1 } });

  const { width, height } = await imageSize(file);
  const words = await recognise(file, langs);
  throwIfAborted(signal);

  return [{ width, height, words: toOcrWords(words, 0, width, height) }];
}

/**
 * Whether these bytes are a PDF.
 *
 * The magic bytes decide, not `file.type`. That field is transport-controlled —
 * a stored object fetched back can arrive as `application/octet-stream` — and
 * getting this wrong is expensive: a JPEG named `.pdf` handed to pdf.js fails
 * much later with an opaque parse error, having downloaded the whole PDF engine
 * first. Five bytes off the front of the file settles it.
 */
async function isPdf(file: Blob, nameHint?: string): Promise<boolean> {
  // A file small enough to be entirely a header is decided by its type alone.
  if (file.size > 0 && file.size <= 8) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(nameHint ?? '');
  }

  try {
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    // "%PDF-" — the ISO 32000-1 file header.
    return (
      header.length === 5 &&
      header[0] === 0x25 &&
      header[1] === 0x50 &&
      header[2] === 0x44 &&
      header[3] === 0x46 &&
      header[4] === 0x2d
    );
  } catch {
    // Unreadable blob: fall back to what the caller declared. This branch is not
    // reachable for a `File` the user just picked, only for a revoked object URL.
    return file.type === 'application/pdf';
  }
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

async function extractFromPdf(
  file: Blob,
  options: Required<Pick<ExtractOptions, 'langs' | 'maxPages'>> & ExtractOptions,
): Promise<OcrPage[]> {
  const { onProgress, signal, langs, maxPages } = options;

  onProgress?.({
    stage: 'loading',
    fraction: null,
    message: 'Preparing the PDF reader…',
  });

  // Dynamic import: a PNG/JPEG upload should never pay for the PDF bundle.
  const pdfjs = await import('pdfjs-dist');

  // Vite rewrites this to an asset URL. Without the assignment below, pdf.js
  // looks for its worker beside `document.baseURI` and 404s, which surfaces as
  // "Setting up fake worker failed".
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const bytes = new Uint8Array(await file.arrayBuffer());
  // The *loading task* is what owns the worker and the teardown; `doc` is only a
  // handle onto the loaded document and has no `destroy`. Getting this wrong
  // leaks a pdf.js worker per PDF, which survives navigation because workers
  // outlive the document that spawned them.
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;
  const total = doc.numPages;
  const pagesToRead = Math.min(total, maxPages);

  const pages: OcrPage[] = [];

  try {
    if (total > pagesToRead) {
      onProgress?.({
        stage: 'reading',
        fraction: 0,
        message: `This PDF has ${total} pages. Reading the first ${pagesToRead}.`,
        page: { current: 0, total },
      });
    }

    for (let index = 1; index <= pagesToRead; index += 1) {
      throwIfAborted(signal);

      const pdfPage = await doc.getPage(index);

      // Read at the page's own scale, then multiply up. Asking pdf.js for
      // `RENDER_SCALE` directly would ignore the page's intrinsic size and
      // produce a canvas whose pixel box does not match the coordinate space
      // tesseract reports.
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: unscaled.scale * RENDER_SCALE });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext('2d', { willReadFrequently: false });
      if (!context) throw new Error('This browser cannot render the PDF for reading.');

      await pdfPage.render({ canvasContext: context, viewport, canvas }).promise;

      onProgress?.({
        stage: 'reading',
        fraction: (index - 1) / pagesToRead,
        message: `Reading page ${index} of ${pagesToRead}…`,
        page: { current: index, total: pagesToRead },
      });

      const words = await recognise(canvas, langs);
      pdfPage.cleanup();

      // An empty page is still a page: it keeps "page 3 was blank"
      // distinguishable from "page 3 was missing", which is the difference
      // between a partly-filled sheet and a failed read.
      pages.push({
        width: canvas.width,
        height: canvas.height,
        words: toOcrWords(words, pages.length, canvas.width, canvas.height),
      });
    }
  } finally {
    // Also runs when a page throws or the teacher cancels, which is the case
    // that matters: without it an aborted 20-page PDF leaks its worker.
    await loadingTask.destroy();
  }

  return pages;
}

/* -------------------------------------------------------------------------- */
/* Tesseract plumbing                                                          */
/* -------------------------------------------------------------------------- */

export interface RawWord {
  text: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Read the words out of a recognition result.
 *
 * ── This traversal is the fragile part ────────────────────────────────────────
 * tesseract.js does not expose a flat word list on the page. Words sit four
 * levels down:
 *
 *     data.blocks[].paragraphs[].lines[].words[]
 *
 * Earlier majors did have `data.words`, and reaching for it returns `undefined`
 * rather than throwing — so the failure mode is a mark sheet that reads as blank,
 * with no error anywhere. This is exported so it can be pinned by tests rather
 * than left to be discovered as "OCR returns nothing" in production.
 *
 * Both shapes are accepted, so a version that adds the flat list back is handled
 * without a code change and one that drops the nesting still works.
 *
 * `blocks` is requested explicitly in the output formats; it is not returned by
 * default, and asking for `text` alone would give the parser nothing to group.
 */
export function readWords(data: unknown): RawWord[] {
  if (data === null || typeof data !== 'object') return [];

  const page = data as {
    words?: RawWord[];
    blocks?: Array<{
      paragraphs?: Array<{
        lines?: Array<{ words?: RawWord[] }>;
      }>;
    }>;
  };

  if (Array.isArray(page.words)) return page.words;

  const collected: RawWord[] = [];

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          collected.push(word);
        }
      }
    }
  }

  return collected;
}

async function recognise(
  image: Blob | HTMLCanvasElement,
  langs: string,
): Promise<RawWord[]> {
  const worker = await getWorker(langs);
  const result = await worker.recognize(image, {}, { blocks: true });

  return readWords(result.data);
}

/**
 * Pixel boxes in, normalised 0..1 fractions out.
 *
 * Exported because this is the second silent-failure site in this module.
 * `parseMarkSheet` groups rows by comparing `bbox.y` across words; a `NaN` there
 * compares false against everything, so the word drops out of every group and its
 * mark is quietly lost. A `clamp01` that maps NaN to 0 keeps a malformed box
 * visible as a wrong row in review instead of invisible as a missing one.
 */
export function toOcrWords(
  words: RawWord[],
  page: number,
  pageWidth: number,
  pageHeight: number,
): OcrWord[] {
  const out: OcrWord[] = [];

  for (const word of words) {
    const text = (word.text ?? '').trim();
    if (!text) continue;

    const box = word.bbox;
    if (!box || pageWidth <= 0 || pageHeight <= 0) continue;

    out.push({
      text,
      // Tesseract is 0..100; anything out of range means the shape changed and a
      // clamp is better than a NaN propagating into the confidence bands.
      confidence: clamp01((word.confidence ?? 0) / 100),
      bbox: {
        page,
        x: clamp01(box.x0 / pageWidth),
        y: clamp01(box.y0 / pageHeight),
        width: clamp01(Math.max(0, (box.x1 - box.x0) / pageWidth)),
        height: clamp01(Math.max(0, (box.y1 - box.y0) / pageHeight)),
      },
    });
  }

  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('The read was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Image dimensions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Intrinsic size of an image, read without decoding it twice.
 *
 * `createImageBitmap` is preferred: it is off the DOM, needs no `<img>` in the
 * document, and gives the size before any full decode. `createImageBitmap` is
 * absent in older Safari, hence the `<img>` fallback.
 */
async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  const url = URL.createObjectURL(file);

  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('That image could not be read.'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}