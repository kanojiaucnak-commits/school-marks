/**
 * The client-side OCR pipeline, from a chosen file to rows in the review screen.
 *
 * Split across two runtimes on purpose:
 *
 *   browser   recognise (Tesseract.js)  → words + boxes
 *   server    parse → match → persist   → `ocr_results`, all `verified = false`
 *
 * The browser could in principle do the parsing too — the pure functions live in
 * `ocr-process` and have no dependencies on anything privileged. It is kept out
 * of the browser for two reasons that are about trust rather than code reuse:
 *
 *  1. The matcher resolves names against the section roster. RLS is the
 *     authorisation boundary for this system, and a roster computed in the
 *     browser is a roster the browser was handed wholesale.
 *  2. `replace_ocr_results` writes many rows across a status update in one
 *     transaction. Reimplementing that client-side would mean a partial failure
 *     leaves a document looking complete when it is not.
 *
 * So recognition is local, and the decisions are not. That is the whole design,
 * and it is why this file is mostly sequencing rather than logic.
 */

import type { OcrDocument } from '@school/shared';
import { QueryError } from '../query';
import { getDocumentSignedUrl, processOcrPages, uploadMarkSheet } from '../repos/storage';
import { extractPages, type OcrPage, type OcrProgress } from './extract';

export interface ScanScope {
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
}

export interface ScanProgress extends OcrProgress {
  /** Which phase, so the UI can say something more useful than a percentage. */
  phase: 'uploading' | 'reading' | 'matching';
}

export interface ScanResult {
  document: OcrDocument;
  resultCount: number;
  needsReview: number;
  averageConfidence: number;
}

/**
 * Upload a file, read it, and post the words for matching.
 *
 * Ordered so that a failure is always attributable: the document row exists
 * before any expensive work starts, so a teacher who loses their laptop
 * mid-recognition still has an upload they can retry rather than an orphaned
 * file in a bucket with no row pointing at it.
 */
export async function scanMarkSheet(
  file: File,
  scope: ScanScope,
  onProgress: (progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<ScanResult> {
  onProgress({ phase: 'uploading', stage: 'loading', fraction: null, message: 'Uploading the file…' });

  const document = await uploadMarkSheet({ file, ...scope });

  const pages = await extractPages(file, {
    signal,
    onProgress: (progress) => onProgress({ ...progress, phase: 'reading' }),
  });

  if (pages.length === 0) {
    throw new QueryError(
      'OCR_NOT_COMPLETED',
      'No text could be read from that mark sheet. Try a clearer photograph, or enter the marks by hand.',
    );
  }

  onProgress({
    phase: 'matching',
    stage: 'parsing',
    fraction: null,
    message: 'Matching the rows against the class roll…',
  });

  const result = await matchPages(document.id, pages);

  return {
    document,
    resultCount: result.resultCount,
    needsReview: result.needsReview,
    averageConfidence: result.averageConfidence,
  };
}

/**
 * Match already-recognised pages and return the refreshed document.
 *
 * Split out because "retry" reuses it exactly: the teacher re-reads the file and
 * this is the only server call needed to rebuild the rows.
 */
export async function matchPages(
  documentId: string,
  pages: OcrPage[],
): Promise<{
  resultCount: number;
  needsReview: number;
  averageConfidence: number;
}> {
  const result = await processOcrPages({ documentId, pages });

  return {
    resultCount: result.resultCount,
    needsReview: result.needsReview,
    averageConfidence: result.averageConfidence,
  };
}

/**
 * Re-read a stored upload and rebuild its rows.
 *
 * This is what "retry" now does, and it is a real retry rather than the previous
 * one. `ocr-retry` used to flip the document back to `QUEUED` and delete its
 * rows, then report that re-extraction had started — but nothing re-triggered
 * `ocr-process`, so the document sat at `QUEUED` forever behind a spinner. With
 * recognition in the browser there is no background worker to wait on, so the
 * retry is simply: fetch the bytes, read them again, post the words.
 *
 * Fetching rather than asking the teacher to pick the file again is deliberate.
 * The original is already stored in a private bucket under a 60-second signed
 * URL, and re-reading the *same* bytes is the only way the retry is comparable to
 * the attempt it replaces. It also means retry works from a document list on a
 * phone, where re-picking a file from cloud storage is a worse experience than a
 * spinner.
 */
export async function rescanDocument(
  documentId: string,
  onProgress: (progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<{ resultCount: number; needsReview: number; averageConfidence: number }> {
  onProgress({ phase: 'reading', stage: 'loading', fraction: null, message: 'Fetching the original file…' });

  const signedUrl = await getDocumentSignedUrl(documentId);

  const response = await fetch(signedUrl);

  if (!response.ok) {
    throw new QueryError(
      'NOT_FOUND',
      'The uploaded mark sheet could not be fetched. It may have been deleted.',
    );
  }

  const blob = await response.blob();

  const pages = await extractPages(blob, {
    signal,
    nameHint: 'mark-sheet',
    onProgress: (progress) => onProgress({ ...progress, phase: 'reading' }),
  });

  if (pages.length === 0) {
    throw new QueryError(
      'OCR_NOT_COMPLETED',
      'No text could be read from that mark sheet this time either. Try a clearer scan, or enter the marks by hand.',
    );
  }

  onProgress({
    phase: 'matching',
    stage: 'parsing',
    fraction: null,
    message: 'Matching the rows against the class roll…',
  });

  return matchPages(documentId, pages);
}