/**
 * RFC 4180 CSV, ported from `toCsv()` / `parseCsv()` in @school/shared.
 *
 * Kept here rather than imported because Edge Functions run on Deno and cannot
 * resolve the workspace package. The two implementations are pinned to one
 * contract by `shared/tests/csv.test.ts`, which asserts the shared copy against
 * exactly these behaviours.
 *
 * The writer emits a UTF-8 BOM, matching the shared implementation. That is not
 * decoration: student names here routinely contain accented characters, and
 * without it Excel opens the file as Latin-1 and mangles every one of them.
 */

const DELIMITER = ',';
const BOM = '\uFEFF';

/** Write rows as CSV. */
export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]): string {
  if (rows.length === 0 && !headers) return '';

  // Union of every row's keys, matching the shared implementation. Taking only the
  // first row's keys would drop a column that appears later in the file, shifting
  // every subsequent cell one place left.
  const columns = headers ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const lines = [columns.map(escapeField).join(DELIMITER)];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeField(row[column])).join(DELIMITER));
  }

  return `${BOM}${lines.join('\r\n')}\r\n`;
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;

  // Leading or trailing whitespace is quoted so it survives a round trip through
  // a spreadsheet, which would otherwise trim it silently.
  if (text !== text.trim()) return `"${text}"`;

  return text;
}

/** Parse CSV text into rows of cells. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (input[i + 1] === '"') {
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
    } else if (char === DELIMITER) {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallow CRLF as one terminator.
      if (input[i + 1] === '\n') i += 1;
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

  // A trailing field with no final newline still counts.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim().length > 0);
}

/** Parse CSV into objects keyed by the header row. */
export function parseCsvToObjects(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];

  const headers = rows[0]!.map((h) => h.trim());

  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    return record;
  });
}