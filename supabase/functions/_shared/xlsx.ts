/**
 * Minimal XLSX writer, ported from `worker/src/lib/xlsx.ts`.
 *
 * Hand-rolled OOXML rather than SheetJS, exactly as the retired Worker did —
 * an XLSX file is a ZIP of XML parts, and for "write a styled table" that is
 * genuinely less code than pulling in a spreadsheet library.
 *
 * ZIP is done with `fflate`, which runs unchanged on the Deno runtime. It is an
 * npm package, so it is pulled in as `npm:fflate` — there is no JSR mirror, and
 * `jsr:@fflate/core` fails to resolve. Files are stored uncompressed (STORE): the
 * payloads here are small text, and skipping DEFLATE removes the only real cost.
 *
 * Scope is deliberately narrow: inline strings, a bold header row, a frozen top
 * row, an autofilter and sane margins. No shared strings, no formulas, no styles
 * beyond the header.
 */

import { zipSync, strToU8 } from 'npm:fflate@0.8.2';

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function columnLetter(index: number): string {
  let n = index;
  let result = '';

  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }

  return result;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // Control characters are illegal in XML 1.0 even when escaped, so they are
  // dropped rather than encoded. A stray 0x00 in a student's name would otherwise
  // produce a file Excel refuses to open.
  '\x00': '',
  '\x01': '',
  '\x02': '',
  '\x03': '',
  '\x04': '',
  '\x05': '',
  '\x06': '',
  '\x07': '',
  '\x08': '',
  '\x0b': '',
  '\x0c': '',
  '\x0e': '',
  '\x0f': '',
};

export function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => XML_ESCAPES[c] ?? '');
}

/** A cell reference like "B7". */
function ref(row: number, col: number): string {
  return `${columnLetter(col)}${row}`;
}

/**
 * Build a single-sheet workbook.
 *
 * Returns the bytes of the .xlsx file. Numbers are written as numeric cells so a
 * recipient can sum a column; everything else is an inline string.
 */
export function buildWorkbook(
  rows: Array<Record<string, unknown>>,
  sheetName = 'Export',
): Uint8Array {
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const safeSheetName = (sheetName || 'Export').replace(/[\\/?*[\]:]/g, '-').slice(0, 31);

  const sheetRows: string[] = [];

  // Header
  sheetRows.push(
    `<row r="1">${columns
      .map((column, index) => `<c r="${ref(1, index)}" s="1" t="inlineStr"><is><t>${escapeXml(column.replace(/_/g, ' '))}</t></is></c>`)
      .join('')}</row>`,
  );

  // Data
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;

    const cells = columns.map((column, colIndex) => {
      const value = row[column];
      const cellRef = ref(rowNumber, colIndex);

      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${cellRef}"><v>${value}</v></c>`;
      }

      if (value === null || value === undefined || value === '') return '';

      return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    });

    sheetRows.push(`<row r="${rowNumber}">${cells.join('')}</row>`);
  });

  const lastRef = ref(rows.length + 1, Math.max(columns.length, 1) - 1);
  const lastColumn = columnLetter(Math.max(columns.length, 1) - 1);

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    ),

    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    ),

    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    ),

    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    ),

    // Two fonts and two cell formats: body, and bold white-on-navy header.
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`,
    ),

    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastRef}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="18" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
${columns.length > 0 ? `<autoFilter ref="A1:${lastRef}"/>` : ''}
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`,
    ),
  };

  // level 0 = STORE (no compression)
  return zipSync(files, { level: 0 }) as Uint8Array;
}

/** The header row text is the column list, so `lastColumn` is used for a width hint. */
export const SHEET_NAME_MAX = 31;

/** True if the buffer starts with the ZIP local-file-header signature. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Referenced so the helper above is not tree-shaken away as unused. */
export const __lastColumnHelper = columnLetter;

/** Recompute the last column letter for a given column count. */
export function lastColumnFor(count: number): string {
  return columnLetter(Math.max(count, 1) - 1);
}

/** Convenience: build a workbook from a CSV string. */
export function workbookFromCsv(csv: string, sheetName?: string): Uint8Array {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length === 0) return buildWorkbook([], sheetName);

  const headers = lines[0]!.split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    return record;
  });

  return buildWorkbook(rows, sheetName);
}