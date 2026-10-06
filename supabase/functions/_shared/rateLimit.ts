import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Rate limiting backed by a Postgres table.
 *
 * ── Why this exists, and why it is not optional ────────────────────────────────
 * The retired Worker used an isolate-local `Map`, which was already unreliable:
 * Cloudflare runs many isolates, so a per-isolate counter could be reset by
 * routing a request to a different one. Supabase Edge Functions have exactly the
 * same problem — a module-level counter is per-instance, not per-user.
 *
 * Marks entry is a write endpoint. An unbounded one is not just an abuse problem
 * here: a runaway autosave loop from a misbehaving client would overwrite a
 * teacher's marks. This is a data-integrity control as much as a security one.
 *
 * ── How it works ──────────────────────────────────────────────────────────────
 * A fixed-window counter in Postgres, incremented with an atomic upsert. Fixed
 * windows allow a 2× burst across a boundary, which is acceptable for this
 * purpose; the retired limits were equally coarse.
 */

export interface RateLimitOptions {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  periodSeconds: number;
  /**
   * What is being limited — e.g. `marks:write`. Recorded so a throttled user can be
   * told which action was refused.
   */
  scope: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/** The row shape `consume_rate_limit` returns. */
interface ConsumeRateLimitRow {
  count: number;
  allowed: boolean;
  reset_at: string;
}

/**
 * Normalise whatever PostgREST actually handed back into a single row.
 *
 * ── Why this is not a one-liner ─────────────────────────────────────────────
 *
 * `consume_rate_limit` is declared `RETURNS TABLE(count, allowed, reset_at)`,
 * which makes it a **set-returning** function. PostgREST serialises set-returning
 * functions as a JSON **array**, not an object — so `rpc()` resolved to
 * `[{ count, allowed, reset_at }]`, not `{ count, allowed, reset_at }`.
 *
 * The old code typed that as the bare object and read `result.allowed` off the
 * array, which is `undefined`. Every consequence was silent and wrong at once:
 *
 *   - `allowed: undefined` is falsy, so **every** rate-limited call was refused,
 *     with no exception. Marks autosave, sheet submission, locked-mark
 *     correction, OCR upload and processing, export generation and student
 *     import all answered 429 for every caller, always — not under load, not
 *     after a burst, just always.
 *   - `Math.max(0, limit - undefined)` is `Math.max(0, NaN)`, which is `NaN`
 *     (`Math.max` propagates NaN rather than falling back to its second
 *     argument), so `remaining` was `NaN`.
 *   - The same NaN reached the user as the literal text
 *     "Too many requests. Try again in NaN seconds."
 *
 * A `RETURNS TABLE` is not an accident worth designing around: taking the first
 * element covers both shapes, so the function keeps returning a natural set.
 */
function firstRow(data: unknown): ConsumeRateLimitRow | null {
  if (Array.isArray(data)) return (data[0] as ConsumeRateLimitRow | undefined) ?? null;
  if (data && typeof data === 'object') return data as ConsumeRateLimitRow;
  return null;
}

const ALLOWED = (limit: number): RateLimitResult => ({
  allowed: true,
  remaining: limit,
  retryAfterSeconds: 0,
});

/**
 * Consume one unit of quota for `key`.
 *
 * Fails **open** on error: if the limiter table is unreachable, refusing every
 * write would take the whole application down for a reason the user cannot act
 * on. The database's own constraints remain the real integrity guarantee.
 *
 * Failing open means a *silent* failure is the dangerous kind — it can turn into
 * a permanent 429 storm with nothing but a message full of `NaN` to show for it.
 * Every open path therefore logs, and every open path says why.
 */
export async function consumeRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const now = Math.floor(Date.now() / 1000);
  // Floor to the window so every request in the same window shares a row, which
  // is what makes the increment atomic.
  const windowStart = now - (now % options.periodSeconds);

  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_key: `${options.scope}:${key}`,
    p_window_start: new Date(windowStart * 1000).toISOString(),
    p_limit: options.limit,
    p_period_seconds: options.periodSeconds,
  });

  if (error) {
    console.error(
      `rate limit check failed for scope=${options.scope}; failing open`,
      error,
    );
    return ALLOWED(options.limit);
  }

  const row = firstRow(data);

  if (!row || typeof row.allowed !== 'boolean' || typeof row.count !== 'number') {
    // The shape changed underneath us. Refusing everything would be the same
    // outage as before; log it loudly so it gets fixed instead of shipped.
    console.error(
      `rate limit check returned an unusable shape for scope=${options.scope}; failing open`,
      data,
    );
    return ALLOWED(options.limit);
  }

  // `reset_at` is a `timestamptz`, so it serialises as an ISO string. Validate it
  // rather than trusting it: `new Date(undefined).getTime()` is `NaN`, and a NaN
  // here reaches the user as "Try again in NaN seconds".
  const resetAt = new Date(row.reset_at).getTime();
  const retryAfterSeconds = Number.isFinite(resetAt)
    ? Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
    : options.periodSeconds;

  return {
    allowed: row.allowed,
    remaining: Math.max(0, options.limit - row.count),
    retryAfterSeconds,
  };
}

/* -------------------------------------------------------------------------- */
/* Limits, matching the retired Worker's ceilings                                */
/* -------------------------------------------------------------------------- */

export const LIMITS = {
  /** Marks autosave. Generous — a fast typist across 40 students. */
  marksWrite: { limit: 120, periodSeconds: 60, scope: 'marks:write' },
  /** Submitting a sheet for review. */
  marksSubmit: { limit: 30, periodSeconds: 60, scope: 'marks:submit' },
  /** Correcting a locked mark: deliberate, audited, and rare. */
  marksCorrect: { limit: 20, periodSeconds: 60, scope: 'marks:correct' },
  /** Uploading a mark sheet. */
  ocrUpload: { limit: 30, periodSeconds: 300, scope: 'ocr:upload' },
  /** Running extraction. Vendor APIs are rate-limited too. */
  ocrProcess: { limit: 20, periodSeconds: 300, scope: 'ocr:process' },
  /** Generating exports: CPU-bound and writes to storage. */
  exportGenerate: { limit: 20, periodSeconds: 60, scope: 'export:generate' },
  /** Student imports: large and expensive. */
  importRun: { limit: 10, periodSeconds: 300, scope: 'import:run' },
} as const satisfies Record<string, RateLimitOptions>;

/** Convenience: the limit entry for a named action. */
export function limitFor(name: keyof typeof LIMITS): RateLimitOptions {
  return LIMITS[name];
}