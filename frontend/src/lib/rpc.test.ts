import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryError, rpc } from './query';

/**
 * `rpc` unwraps PostgREST's response for the Postgres functions in
 * `supabase/migrations/0004_functions.sql`.
 *
 * ── The bug this pins ────────────────────────────────────────────────────────
 *
 * The original read the payload as `data?.[0]`, which is only right for a
 * set-returning function. PostgREST answers those with a JSON **array** and a
 * scalar-returning one with a JSON **object** — and every function this app
 * actually calls is scalar-returning:
 *
 *   save_marks_grid            RETURNS jsonb  → object
 *   apply_submission_transition RETURNS jsonb  → object
 *   save_grading_scheme        RETURNS uuid   → string
 *   set_default_grading_scheme RETURNS uuid   → string
 *   touch_last_login           RETURNS void   → null
 *
 * So `data?.[0]` was `undefined` for the jsonb pair and the *first character* for
 * the uuid pair, and `?? null` turned the rest into `null`. All three call sites
 * discarded the result, so the type checker stayed quiet and nothing looked
 * broken:
 *
 *   - `saveMarksGrid` returned `null` instead of its `{ok, message, version}`
 *     envelope, so the grid's autosave had no outcome to report.
 *   - `transitionSubmission` called `unwrap(null)`, whose `result?.ok !== true`
 *     test is true — so **every** submit, approve and reject threw "That action
 *     was refused."
 *   - `saveGradingScheme` returned `"3"` where a uuid belonged.
 *
 * Each of those was a silent, permanent failure on a core teacher workflow, found
 * only because the first rate-limited request ever sent turned out to be a 429.
 */

const rpcMock = vi.fn();

vi.mock('./supabase', () => ({
  getSupabase: () => ({ rpc: rpcMock }),
}));

/** The response PostgREST sends for a `RETURNS TABLE(...)` function. */
function tableResponse(row: unknown) {
  return { data: [row], error: null };
}

/** The response for a scalar-returning function. */
function scalarResponse(value: unknown) {
  return { data: value, error: null };
}

describe('rpc', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the returned shape', () => {
    it('takes the first row of a set-returning function', async () => {
      rpcMock.mockResolvedValue(
        tableResponse({ count: 4, allowed: true, reset_at: '2026-10-05T21:00:00+00:00' }),
      );

      await expect(rpc('consume_rate_limit')).resolves.toEqual({
        count: 4,
        allowed: true,
        reset_at: '2026-10-05T21:00:00+00:00',
      });
    });

    it('returns a jsonb payload whole, not its first key', async () => {
      // The regression: `[0]` on this object is `undefined`.
      const envelope = { ok: true, message: 'Saved 4 marks.', version: 7 };
      rpcMock.mockResolvedValue(scalarResponse(envelope));

      await expect(rpc('save_marks_grid')).resolves.toEqual(envelope);
    });

    it('returns a uuid whole, not its first character', async () => {
      // The regression: `'00000000-0000-…'.0` is `'0'`.
      const id = '00000000-0000-0000-0000-000000000101';
      rpcMock.mockResolvedValue(scalarResponse(id));

      await expect(rpc<string>('save_grading_scheme')).resolves.toBe(id);
    });

    it('returns a boolean as itself', async () => {
      rpcMock.mockResolvedValue(scalarResponse(true));

      await expect(rpc<boolean>('has_permission_for')).resolves.toBe(true);
    });

    it('returns null for a function that yields nothing', async () => {
      // `touch_last_login` is `RETURNS void`; PostgREST sends `data: null`.
      rpcMock.mockResolvedValue(scalarResponse(null));

      await expect(rpc('touch_last_login')).resolves.toBeNull();
    });

    it('returns null for an empty result set', async () => {
      rpcMock.mockResolvedValue(tableResponse(undefined));

      await expect(rpc('consume_rate_limit')).resolves.toBeNull();
    });
  });

  describe('errors', () => {
    it('raises a QueryError, so the message is one a person can act on', async () => {
      // The defect the old copy carried: `new Error(error.message)` handed the
      // caller Postgres text, where the query path maps 23505 to a sentence.
      rpcMock.mockResolvedValue({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "subjects_code_key"',
          details: 'Key (code)=(ENG) already exists.',
          hint: null,
        },
      });

      const caught = await rpc('save_subject').catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(QueryError);
      expect((caught as QueryError).code).toBe('23505');
      expect((caught as QueryError).message).not.toContain('pg_policies');
      expect((caught as QueryError).message).not.toContain('duplicate key value');
    });

    it('passes the arguments through untouched', async () => {
      rpcMock.mockResolvedValue(scalarResponse(null));

      await rpc('set_default_grading_scheme', { p_scheme_id: 'abc' });

      expect(rpcMock).toHaveBeenCalledWith('set_default_grading_scheme', {
        p_scheme_id: 'abc',
      });
    });

    it('defaults the arguments to an empty object', async () => {
      rpcMock.mockResolvedValue(scalarResponse(null));

      await rpc('touch_last_login');

      expect(rpcMock).toHaveBeenCalledWith('touch_last_login', {});
    });
  });
});