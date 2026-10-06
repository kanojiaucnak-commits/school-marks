/**
 * Pure helpers shared by both runtimes. Everything here must be side-effect free
 * so it can be unit-tested in isolation and reused in Edge Functions and the browser.
 */

import { confidenceBand, isNumericMarkStatus, type MarkStatus } from './constants.js';

/* -------------------------------------------------------------------------- */
/* IDs                                                                         */
/* -------------------------------------------------------------------------- */

/** UUID v4 via Web Crypto — available in browsers, Deno and Node 20+. */
export function uuid(): string {
  return crypto.randomUUID();
}

/** Short, URL-safe, unambiguous token for sessions and password resets. */
export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Whether a timestamp has passed.
 *
 * A missing or unparseable value counts as expired. The alternative — treating
 * "unknown" as "still valid" — means a row with no expiry silently behaves like
 * a permanent credential, which is the wrong direction to fail.
 */
export function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return true;
  return time <= Date.now();
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

/* -------------------------------------------------------------------------- */
/* Marks validation                                                            */
/* -------------------------------------------------------------------------- */

export interface MarkInputValue {
  marks: string | number | null;
  status?: MarkStatus | null;
}

export type MarkValidationCode =
  | 'ok'
  | 'required'
  | 'not_a_number'
  | 'below_zero'
  | 'above_maximum'
  | 'has_decimals_beyond_precision';

export interface MarkValidationResult {
  valid: boolean;
  code: MarkValidationCode;
  value: number | null;
  message?: string;
}

/**
 * Validate a single marks cell.
 *
 * Business Rule 4: marks can never exceed the exam's maximum.
 * Non-numeric statuses (ABSENT / EXEMPTED / MEDICAL) must NOT carry a numeric
 * mark — they are treated as "no mark awarded" rather than zero.
 */
export function validateMark(
  raw: string | number | null | undefined,
  maxMarks: number,
  status: MarkStatus = 'PRESENT',
): MarkValidationResult {
  if (!isNumericMarkStatus(status)) {
    return { valid: true, code: 'ok', value: null };
  }

  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text === '') {
    return { valid: false, code: 'required', value: null, message: 'Mark is required' };
  }

  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return { valid: false, code: 'not_a_number', value: null, message: 'Must be a number' };
  }
  if (numeric < 0) {
    return { valid: false, code: 'below_zero', value: numeric, message: 'Marks cannot be negative' };
  }
  if (numeric > maxMarks) {
    return {
      valid: false,
      code: 'above_maximum',
      value: numeric,
      message: `Marks cannot exceed the maximum of ${maxMarks}`,
    };
  }
  // Marks are stored as REAL for fractional exams, but 3 dp is the practical
  // ceiling and keeps float noise out of percentage maths.
  const rounded = Math.round(numeric * 1000) / 1000;
  if (Math.abs(rounded - numeric) > 1e-9) {
    return {
      valid: false,
      code: 'has_decimals_beyond_precision',
      value: numeric,
      message: 'Marks allow at most 3 decimal places',
    };
  }
  return { valid: true, code: 'ok', value: rounded };
}

export function percentageOf(marks: number | null, maxMarks: number): number | null {
  if (marks === null || maxMarks <= 0) return null;
  return roundTo((marks / maxMarks) * 100, 2);
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/* -------------------------------------------------------------------------- */
/* Name normalisation & fuzzy matching                                         */
/* -------------------------------------------------------------------------- */

/**
 * Aggressively normalise a scanned name for comparison:
 * "Rahul  Sharm" / "RAHUL SHARMA." / "Rahul   Sharm   a" → "rahulsharma"
 */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalisation that also removes all whitespace, for the strictest tier. */
export function squashName(input: string | null | undefined): string {
  return normalizeName(input).replace(/\s+/g, '');
}

/**
 * Levenshtein distance with an early-exit bound. Used by the OCR fuzzy matcher;
 * tuned for short names (< 60 chars) where the O(n·m) cost is negligible.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0] ?? 0;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1, // insertion
        (previous[j] ?? 0) + 1, // deletion
        (previous[j - 1] ?? 0) + cost, // substitution
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/**
 * Similarity in [0, 1] combining token-order-insensitive Levenshtein on the
 * squashed form with per-token overlap, so "Rahul Kumar Sharma" still matches
 * "Rahul Sharma".
 */
export function nameSimilarity(a: string, b: string): number {
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const squashScore = 1 - levenshtein(squashName(a), squashName(b)) / Math.max(squashName(a).length, squashName(b).length, 1);

  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  const union = new Set<string>([...tokensA, ...tokensB]).size;
  const tokenScore = union === 0 ? 0 : shared / union;

  return Math.max(0, Math.min(1, Math.max(squashScore, tokenScore * 0.97)));
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/** RFC 4180 CSV serialiser (quotes fields containing delimiters/quotes/newlines). */
export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]): string {
  if (rows.length === 0 && !headers) return '';
  const columns = headers ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  // BOM keeps Excel happy with UTF-8 student names.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * RFC 4180 CSV parser that tolerates quoted newlines and doubled quotes.
 * Deliberately hand-rolled: no Node-only dependency, runs identically anywhere.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

export function parseCsvToObjects(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = (rows[0] ?? []).map((cell) => cell.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      if (key) record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function confidenceLabel(confidence: number | null): string {
  if (confidence === null || Number.isNaN(confidence)) return 'Unknown';
  return `${Math.round(confidence * 100)}%`;
}

export { confidenceBand };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 180);
}

export function initialsOf(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}