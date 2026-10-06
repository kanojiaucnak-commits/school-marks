/**
 * Rewriting the database URL to go through Supabase's connection pooler.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────────
 *
 * Every authenticated request to an Edge Function was taking about four seconds. The
 * cause was not in the query path. Supabase auto-injects `SUPABASE_DB_URL` pointing at
 * `db.<ref>.supabase.co`, and on this project that name has **no A record at all**:
 *
 *     db.nhqobdectcswnfmmyqtw.supabase.co  AAAA  2406:da12:557:f800:6e14:1cd4:…
 *
 * The database is reachable only over IPv6. The Edge runtime has no usable IPv6
 * egress, so each connection attempt waited on a blackholed route before falling back.
 * The pooler host is the opposite, resolving to IPv4:
 *
 *     aws-0-ap-northeast-2.pooler.supabase.com  A  15.164.120.176  (and siblings)
 *
 * Routing through it took the same request from ~4,200ms to ~1,100ms.
 *
 * ── Two things the pooler needs, both learned the hard way ─────────────────────
 *
 * 1. **A tenant identifier in the username.** Supabase's pooler is Supavisor, which
 *    multiplexes many projects onto one endpoint and identifies the tenant by user
 *    name. With the plain `postgres` user it refuses the connection:
 *
 *        (ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname
 *        required)
 *
 *    The username therefore becomes `postgres.<project-ref>`.
 *
 * 2. **The password must survive untouched.** This project's generated password
 *    contains a `/`, and it is percent-encoded in the URL. Running the URL through
 *    `new URL()` and `toString()` — which is the obvious way to do this — re-encodes
 *    the userinfo and corrupts it, producing a connection that resolves and then fails
 *    authentication. So the rewrite below is purely textual: the password is carried
 *    across as the exact bytes it already had.
 *
 * Returns the original URL untouched when `PG_POOLER_HOST` is unset, so a self-hosted
 * or differently-provisioned deployment is unaffected.
 */

/** The project reference, read out of the injected `db.<ref>.supabase.co` host. */
function projectRefFrom(url: string): string | null {
  const match = /db\.([a-z0-9-]+)\.supabase\.co/i.exec(url);
  // The capture group is inside the pattern, so a match always has one.
  return match?.[1] ?? null;
}

export function poolerUrl(url: string, host: string | undefined, port: string | undefined): string {
  if (!host) return url;

  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return url;

  const authorityStart = schemeEnd + 3;

  // The authority runs to the first path, query or fragment marker.
  let authorityEnd = url.length;
  for (const marker of ['/', '?', '#']) {
    const at = url.indexOf(marker, authorityStart);
    if (at !== -1 && at < authorityEnd) authorityEnd = at;
  }

  const authority = url.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at);

  // Only the password part is reused, and only by slicing after the first colon. It is
  // never decoded and never re-encoded.
  const colon = userinfo.indexOf(':');
  const password = colon === -1 ? '' : userinfo.slice(colon + 1);

  const ref = projectRefFrom(url);
  // `postgres.<ref>` is the tenant-qualified user Supavisor expects. Without a
  // readable ref the connection would be refused, so leave the URL alone rather than
  // guess a tenant.
  const user = ref ? `postgres.${ref}` : userinfo.split(':')[0];
  if (!ref) return url;

  return (
    url.slice(0, authorityStart) +
    `${user}:${password}@${host}:${port ?? '6543'}` +
    url.slice(authorityEnd)
  );
}