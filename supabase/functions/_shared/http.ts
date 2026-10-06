/**
 * Shared helpers for Supabase Edge Functions.
 *
 * The Deno successors to the retired Worker's `lib/http.ts`. The response
 * envelope is unchanged (`{success, data}` / `{success, error}`) so the
 * frontend's error handling reads the same whether a response came from PostgREST
 * or from a function.
 */

import { looksLikeSqlstate, readError } from './pgError.ts';

export interface EdgeError {
  code: string;
  message: string;
  details?: unknown;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-csrf-token',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

export function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS, 'x-content-type-options': 'nosniff' };
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra },
  });
}

export function fail(code: string, message: string, status = 400, details?: unknown): Response {
  const error: EdgeError = { code, message };
  if (details !== undefined) error.details = details;

  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

/** Map an AppError-style code to the HTTP status the old Worker used. */
const STATUS_FOR_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SUBMISSION_NOT_EDITABLE: 422,
  SUBMISSION_LOCKED: 422,
  MARK_OUT_OF_RANGE: 422,
  MARK_INVALID: 422,
  OCR_MATCH_AMBIGUOUS: 422,
  OCR_LOW_CONFIDENCE: 422,
  OCR_NOT_COMPLETED: 422,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 422,
  FILE_CORRUPT: 422,
  IMPORT_VALIDATION_FAILED: 422,
  REASON_REQUIRED: 422,
  INVALID_TRANSITION: 409,
  DUPLICATE_MARKS: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function statusForCode(code: string): number {
  return STATUS_FOR_CODE[code] ?? 400;
}

/**
 * Run a handler and turn anything it throws into a proper envelope.
 *
 * Without this a thrown Postgres error reaches the client as an opaque 500 with a
 * stack trace, which is both unhelpful and a small information leak.
 */
export async function handle(request: Request, fn: () => Promise<Response>): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    return await fn();
  } catch (caught) {
    const error = caught as {
      // Every `Error` has a `name`, and the rate-limit branch below keys off it.
      // Leaving it out of the cast made `error.name` a type error while reading
      // as perfectly valid code, which is how it survived — the functions were
      // not typechecked at all until now.
      name?: string;
      code?: string;
      message?: string;
      details?: unknown;
      hint?: string;
      retryAfterSeconds?: number;
    };

    // A throttled request must say when to retry, not merely that it was refused —
    // a client with no backoff advice will retry immediately and make it worse.
    if (error?.name === 'RateLimitError') {
      const retryAfter = Number(error.retryAfterSeconds ?? 60);
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'RATE_LIMITED', message: error.message ?? 'Too many requests.' },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(retryAfter),
            ...corsHeaders(),
          },
        },
      );
    }

    // Read through `readError`: `@db/postgres` nests the SQLSTATE under `fields`, so
    // `caught.code` is `undefined` for every driver error. Reading it directly meant no
    // database error ever reached the client with its code, and the client's
    // per-code messages never matched anything. See `_shared/pgError.ts`.
    const pg = readError(caught);

    // Postgres raised something — surface the code so the client can branch.
    if (pg.code && looksLikeSqlstate(pg.code)) {
      return fail(pg.code, pg.message ?? 'Database error.', statusForCode(pg.code), pg.hint);
    }

    if (pg.code) {
      return fail(pg.code, pg.message ?? 'Request failed.', statusForCode(pg.code));
    }

    console.error('unhandled edge function error', error);
    return fail('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500);
  }
}

/** Read and parse a JSON body, tolerating an empty one. */
export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}