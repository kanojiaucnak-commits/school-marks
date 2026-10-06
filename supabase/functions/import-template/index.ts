import { hasPermission, requireCaller } from '../_shared/auth.ts';
import { fail, handle } from '../_shared/http.ts';

/**
 * Serve the student-import CSV template.
 *
 * The template ships as a header row plus one worked example row, because an
 * empty file teaches nothing about the expected format — and getting a header
 * wrong silently produces a preview with 500 validation errors.
 */

const HEADERS = [
  'Student Number',
  'Full Name',
  'Admission Number',
  'Roll Number',
  'Date of Birth',
  'Gender',
  'Guardian Name',
  'Guardian Phone',
  'Guardian Email',
];

const EXAMPLE = [
  '2026-0001',
  'Amara Osei',
  'ADM-2026-001',
  '1',
  '2012-04-17',
  'female',
  'Kwame Osei',
  '+233201234567',
  'amara.osei@example.com',
];

const INSTRUCTIONS = [
  '# Student import template',
  '#',
  '# Delete the example row below before uploading your own data.',
  '#',
  '# Column order does not matter, but the header names must match.',
  '# Headers are matched case-insensitively, and these aliases also work:',
  '#   full_name / name, student_number / Student ID, admission_number,',
  '#   roll_number, date_of_birth, guardian_name, guardian_phone, guardian_email.',
  '#',
  '# Date of birth accepts YYYY-MM-DD or DD/MM/YYYY. Ambiguous dates are rejected',
  '# rather than guessed.',
  '#',
  '# Gender accepts male / female / other, or m / f.',
  '#',
  '# A student number must be unique within the academic year you are importing into.',
  '#',
  '# Maximum 5000 rows per file. Every invalid row is reported, not just the first.',
];

/** Quotes a field only when it needs it. */
function escape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'student:import'))) {
        return fail('FORBIDDEN', 'You do not have permission to import students.', 403);
      }

      const lines = [
        ...INSTRUCTIONS,
        HEADERS.map(escape).join(','),
        EXAMPLE.map(escape).join(','),
      ];

      const body = lines.join('\r\n');

      // A BOM makes Excel open UTF-8 correctly, which matters because student
      // names in this system contain non-ASCII characters constantly.
      const encoded = new TextEncoder().encode(`﻿${body}`);

      return new Response(encoded, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="student-import-template.csv"',
          'cache-control': 'private, max-age=0, no-store',
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
        },
      });
    }),
);