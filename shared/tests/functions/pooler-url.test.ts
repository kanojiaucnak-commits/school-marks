import { describe, expect, it } from 'vitest';
import { poolerUrl } from '../../../supabase/functions/_shared/pooler';

/**
 * Every authenticated request took about four seconds because Supabase's injected
 * `SUPABASE_DB_URL` points at an IPv6-only host that the Edge runtime cannot reach;
 * routing through the pooler took it to ~1,100ms. Getting the rewritten URL right took
 * two failures, and both are pinned here.
 *
 * ── Failure 1: no tenant identifier ────────────────────────────────────────────
 *
 * Supabase's pooler is Supavisor, which shares one endpoint across many projects and
 * identifies the tenant from the username. Sending the plain `postgres` user is
 * refused outright:
 *
 *     (ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname
 *     required)
 *
 * ── Failure 2: the password did not survive the rewrite ─────────────────────────
 *
 * This project's generated password contains a `/` and is percent-encoded in the URL.
 * Rewriting with `new URL()` and `toString()` — the obvious implementation — re-encodes
 * the userinfo and corrupts it, yielding a connection that resolves and then fails
 * authentication. The rewrite has to be textual.
 */
const HOST = 'aws-0-ap-northeast-2.pooler.supabase.com';
const REF = 'nhqobdectcswnfmmyqtw';

/** A URL shaped like the real injected one, password complete with a slash. */
const DB_URL =
  `postgresql://postgres:p%40ss%2Fw%3Ard%3Aabc@db.${REF}.supabase.co:5432/postgres?sslmode=require`;

describe('poolerUrl', () => {
  it('produces a tenant-qualified user, which the pooler requires', () => {
    const url = poolerUrl(DB_URL, HOST, '6543');

    expect(url).toContain(`postgres.${REF}:@`.replace(':@', ':'));
    expect(url).toContain(`postgres.${REF}:`);
    // The whole point: the plain user is rejected with ENOIDENTIFIER.
    expect(url).not.toMatch(/:\/\/postgres:p/);
  });

  it('leaves the password byte-for-byte identical, still percent-encoded', () => {
    const url = poolerUrl(DB_URL, HOST, '6543');

    // `p%40ss%2Fw%3Ard%3Aabc` must survive untouched. A URL parser would decode the
    // `%2F` and then re-encode the whole userinfo differently, or split on the
    // characters it now sees.
    expect(url).toContain(':p%40ss%2Fw%3Ard%3Aabc@');
  });

  it('does not decode or re-encode any part of the password', () => {
    const url = poolerUrl(DB_URL, HOST, '6543');
    const password = url.slice(url.indexOf(':', url.indexOf('://') + 3) + 1, url.lastIndexOf('@'));

    expect(password).toBe('p%40ss%2Fw%3Ard%3Aabc');
  });

  it('swaps the host and port, leaving the path and query alone', () => {
    const url = poolerUrl(DB_URL, HOST, '6543');

    expect(url.startsWith('postgresql://')).toBe(true);
    expect(url).toContain(`@${HOST}:6543/`);
    expect(url.endsWith('/postgres?sslmode=require')).toBe(true);
    expect(url).not.toContain('db.nhqobdectcswnfmmyqtw.supabase.co');
  });

  it('defaults to the transaction pooler port', () => {
    // 6543 is transaction mode. Session mode would pin a backend connection per client
    // and serialise a pool of two.
    expect(poolerUrl(DB_URL, HOST, undefined)).toContain(`@${HOST}:6543/`);
  });

  it('returns the URL untouched when no pooler host is configured', () => {
    // A self-hosted or differently-provisioned deployment must not be rewritten.
    expect(poolerUrl(DB_URL, undefined, '6543')).toBe(DB_URL);
  });

  it('refuses to guess when the project reference cannot be read', () => {
    // Without a ref there is no tenant to qualify with, and inventing one produces
    // ENOIDENTIFIER. Leaving the URL alone at least fails visibly on the direct host.
    const unknown = 'postgresql://postgres:secret@localhost:5432/postgres';
    expect(poolerUrl(unknown, HOST, '6543')).toBe(unknown);
  });

  it('tolerates a URL with no query string', () => {
    const bare = `postgresql://postgres:secret@db.${REF}.supabase.co:5432/postgres`;
    const url = poolerUrl(bare, HOST, '6543');

    expect(url).toBe(`postgresql://postgres.${REF}:secret@${HOST}:6543/postgres`);
  });

  it('leaves a host it cannot read a project reference from untouched', () => {
    // Not the shape this project has — its host is `db.<ref>.supabase.co` — but the
    // guard has to hold for it rather than producing something that looks valid. A
    // bracketed IPv6 literal gives no `db.<ref>.supabase.co` to read, so there is no
    // tenant to qualify with. Emitting the pooler host anyway would fail as
    // ENOIDENTIFIER with a URL that looks perfectly correct, which is worse than not
    // rewriting it.
    const bracketed =
      'postgresql://postgres:s%2Fecret@[2001:db8::1]:5432/postgres?sslmode=require';

    expect(poolerUrl(bracketed, HOST, '6543')).toBe(bracketed);
  });
});