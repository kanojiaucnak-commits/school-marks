import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { runPrivileged } from './postgres.ts';

/**
 * Clerk authentication and per-caller authorisation for Edge Functions.
 *
 * ── Why this exists, and why it is not optional ────────────────────────────────
 *
 * Edge Functions must call `has_permission()` themselves. Two reasons:
 *
 *  1. They verify the Clerk token against the instance JWKS, because Supabase
 *     Auth is not the token issuer in this project.
 *  2. More importantly, once a function needs to do something the browser cannot
 *     — mint a signed URL, write to Storage, call a third-party OCR API — it
 *     necessarily uses the **service-role** client. That client bypasses RLS
 *     entirely. Every check that RLS would have performed must therefore be
 *     repeated here by hand.
 *
 * Skipping that is the single easiest way to ship an authorization hole in this
 * architecture, so the helpers below fail closed and are used by every function.
 */

const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER') ?? 'https://clerk.example.com';
const CLERK_JWKS_URL = `${CLERK_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json`;

export interface Caller {
  clerkUserId: string;
  email: string | null;
  /** `admin` | `teacher` | `reviewer`, from the `profiles` row. */
  role: string;
  /** Service-role client. Callers must not leak it to a client. */
  supabase: SupabaseClient;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/* -------------------------------------------------------------------------- */
/* JWT verification                                                             */
/* -------------------------------------------------------------------------- */

let cachedJwks: { keys: unknown[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 5 * 60_000;

async function getJwks(): Promise<unknown[]> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.keys;
  }

  const response = await fetch(CLERK_JWKS_URL);
  if (!response.ok) {
    throw new AuthError('UNAUTHENTICATED', 'Could not verify your session.');
  }

  const body = (await response.json()) as { keys: unknown[] };
  cachedJwks = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return cachedJwks.keys;
}

/**
 * Verify a Clerk session token and return the Clerk user id.
 *
 * ── Signature verification is not optional ────────────────────────────────────
 * An earlier version of this file called `decodeJwt()`, which *parses* a JWT but
 * does not check its signature. Combined with a `kid` lookup against the public
 * JWKS, that was an authentication bypass: anyone could hand-write a token whose
 * `sub` was an administrator's Clerk user id, sign it with a key they made up, and
 * be believed. Because every function here trusts `caller.clerkUserId` — for
 * `profiles` lookup, for audit rows, and for ownership checks — that would have
 * been total compromise.
 *
 * So the signature is genuinely verified here with WebCrypto, which Deno provides
 * natively. No JWT library is involved, and therefore no library to keep current.
 *
 * Checks, in order:
 *   1. the token has three segments
 *   2. `alg` is one we accept — never `none`, and never an algorithm inferred from
 *      the token, which is the classic JWT confusion attack
 *   3. the `kid` matches a key Clerk currently publishes
 *   4. the signature verifies over `header.payload` with that key
 *   5. `exp` has not passed
 *   6. `iss` is this Clerk instance
 *
 * The role is deliberately *not* read from the token: `public_metadata.role` would
 * be stale until Clerk refreshed it, so a just-demoted admin would keep their
 * powers until the token expired. The live `profiles` row is the source of truth,
 * and it is what `has_permission()` in Postgres reads too.
 */
async function verifyClerkToken(token: string): Promise<string> {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new AuthError('UNAUTHENTICATED', 'Malformed session token.');
  }

  const [rawHeader, rawPayload, rawSignature] = segments as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; exp?: number; iss?: string };

  try {
    header = JSON.parse(decodeBase64Url(rawHeader));
    payload = JSON.parse(decodeBase64Url(rawPayload));
  } catch {
    throw new AuthError('UNAUTHENTICATED', 'Malformed session token.');
  }

  // Pin the algorithm. Accepting whatever the token claims is the JWT confusion
  // vulnerability: an attacker signs with HMAC using the public RSA modulus as the
  // secret, and a naive verifier accepts it.
  const algorithm = header.alg;
  if (algorithm !== 'RS256' && algorithm !== 'ES256') {
    throw new AuthError('UNAUTHENTICATED', 'Unsupported token signature algorithm.');
  }

  if (!header.kid) {
    throw new AuthError('UNAUTHENTICATED', 'Malformed session token.');
  }

  const keys = (await getJwks()) as Array<{ kid?: string }>;
  const jwk = keys.find((key) => key.kid === header.kid);

  if (!jwk) {
    // Clerk rotates keys. Drop the cache so the next attempt refetches rather
    // than rejecting a perfectly valid token for the next five minutes.
    cachedJwks = null;
    throw new AuthError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }

  const verified = await verifySignature(algorithm, jwk, `${rawHeader}.${rawPayload}`, rawSignature);

  if (!verified) {
    throw new AuthError('UNAUTHENTICATED', 'Your session could not be verified. Please sign in again.');
  }

  if (!payload.sub) {
    throw new AuthError('UNAUTHENTICATED', 'Malformed session token.');
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp * 1000 < Date.now()) {
    throw new AuthError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }

  // Confirms the token was minted by *this* Clerk instance, not a different one
  // the caller also has an account with.
  const expectedIssuer = CLERK_ISSUER.replace(/\/$/, '');
  const actualIssuer = (payload.iss ?? '').replace(/\/$/, '');
  if (actualIssuer && actualIssuer !== expectedIssuer) {
    throw new AuthError('UNAUTHENTICATED', 'Your session was issued by a different application.');
  }

  return payload.sub;
}

/** Verify `RS256` / `ES256` over the signed portion of the token. */
async function verifySignature(
  algorithm: string,
  jwk: unknown,
  signedData: string,
  rawSignature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as JsonWebKey,
      algorithm === 'RS256'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    return await crypto.subtle.verify(
      algorithm === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'ECDSA',
      key,
      decodeBase64UrlBytes(rawSignature),
      new TextEncoder().encode(signedData),
    );
  } catch (caught) {
    // A malformed JWK is a verification failure, never a pass.
    console.error('signature verification threw', caught);
    return false;
  }
}

/**
 * base64url → UTF-8 string.
 *
 * This has to actually turn the bytes back into text. Returning the byte array
 * directly is a subtle failure: `JSON.parse` coerces it to `"[object Uint8Array]"`
 * and throws, so *every* token — forged or genuine — is reported as malformed and
 * nobody can ever sign in.
 */
function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

/**
 * Decodes base64url into bytes for signature verification.
 *
 * The `Uint8Array<ArrayBuffer>` annotation is deliberate. TypeScript 5.7 split
 * `Uint8Array`'s buffer into `ArrayBuffer` and `SharedArrayBuffer` cases, and
 * `crypto.subtle.verify` only accepts the former. Without the explicit parameter
 * the return type widens to `Uint8Array<ArrayBufferLike>` and the call is a type
 * error — even though the array is always backed by a plain `ArrayBuffer` here,
 * because it is allocated a few lines below.
 */
function decodeBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Request-scoped client                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a Clerk user object needed to provision a profile.
 *
 * `email_addresses` — plural — is where a Clerk user actually keeps their
 * addresses. The singular `email_address` field is null, and
 * `primary_email_address` is *not expanded* into an object in a plain
 * `GET /v1/users/{id}` response; only `primary_email_address_id` is present.
 * Reading the singular field (or the unexpanded object) finds nothing, which is
 * why this previously reported accounts that plainly had a verified email as
 * having none at all.
 */
export interface ClerkUserAccount {
  email_addresses?: Array<{
    id?: string;
    email_address?: string;
    verification?: { status?: string };
  }>;
  primary_email_address_id?: string;
  identities?: Array<{ email_address?: string }>;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
}

/**
 * Pull an email address and a display name out of a Clerk user object.
 *
 * Exported separately from the fetch so it can be tested against a real captured
 * response. This function is the second time in this project that an unverified
 * assumption about a third party's response shape caused a live outage
 * (`primary_email_address` being unexpanded is not documented anywhere obvious),
 * and it is exactly the kind of code that looks obviously right.
 *
 * Preference order: the primary address, then any verified address, then any
 * address, then one attached to an identity. Clerk verification is not what
 * authorises a profile here, so an unverified address is still acceptable — the
 * token signature is the authorisation, not the address.
 */
export function readClerkIdentity(account: ClerkUserAccount): {
  email: string | null;
  fullName: string | null;
} {
  // Clerk serialises an absent collection as `null` rather than `[]`, and a null
  // entry inside the array would throw here — inside authentication, turning a
  // resolvable account into a failed sign-in. Normalise first.
  const addresses = (account.email_addresses ?? []).filter(
    (entry): entry is NonNullable<typeof entry> => entry != null,
  );

  const primary = addresses.find(
    (entry) => entry.id !== undefined && entry.id === account.primary_email_address_id,
  );
  const verified = addresses.find((entry) => entry.verification?.status === 'verified');

  // A Google-only account can carry the address solely on its identity.
  //
  // Null-safe on purpose: Clerk serialises absent collections as `null` rather than
  // `[]`, and one null entry in the array would otherwise throw a TypeError inside
  // authentication, turning a resolvable account into a failed sign-in.
  const candidates = [
    primary?.email_address,
    verified?.email_address,
    ...addresses.map((entry) => entry?.email_address),
    ...(Array.isArray(account.identities)
      ? account.identities.map((entry) => entry?.email_address)
      : []),
  ];

  const email = candidates.find((value) => typeof value === 'string' && value.trim() !== '')
    ?.trim() ?? null;

  const fullName =
    [account.first_name, account.last_name]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join(' ')
      .trim() ||
    account.username?.trim() ||
    null;

  return { email, fullName };
}

/**
 * Create a `profiles` row for a Clerk user, resolving their identity from Clerk.
 *
 * Reads the account from the Clerk Backend API rather than the session token,
 * because the token does not carry an email claim on a default instance. Returns
 * false when the account genuinely has no usable email address, which is the one
 * case the caller needs to explain to the user.
 *
 * Failure to reach Clerk is logged and reported as false rather than thrown: this
 * runs during authentication, and turning a transient network problem into a 500
 * would sign everyone out.
 */
async function provisionFromClerk(clerkUserId: string): Promise<boolean> {
  const secret = Deno.env.get('CLERK_SECRET_KEY');
  const apiBase = Deno.env.get('CLERK_API_BASE') ?? 'https://api.clerk.com';

  if (!secret) {
    console.error('CLERK_SECRET_KEY is not set; cannot resolve a new account');
    return false;
  }

  let email: string | null = null;
  let fullName: string | null = null;

  try {
    const response = await fetch(`${apiBase}/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      console.error('Clerk user lookup failed', response.status);
      return false;
    }

    ({ email, fullName } = readClerkIdentity((await response.json()) as ClerkUserAccount));
  } catch (caught) {
    console.error('Clerk user lookup threw', caught);
    return false;
  }

  if (!email) {
    console.error('Clerk account carries no usable email address', { clerkUserId });
    return false;
  }

  // Direct Postgres, for the same reason the profile read above is: this runs on the
  // first authenticated request of every new account, and a PostgREST round trip here
  // would be the difference between signing in quickly and signing in slowly.
  //
  // `provision_profile_as` is granted to `service_role` only. `runPrivileged` runs as
  // the pool owner, which is that role's privilege level — and the browser can never
  // reach this statement, so neither the id nor the email can be supplied by a caller.
  const { error } = await runPrivileged(async (sql) => {
    try {
      await sql.query('select public.provision_profile_as($1, $2, $3)', [
        clerkUserId,
        email,
        fullName,
      ]);
      return { error: null };
    } catch (caught) {
      return { error: caught };
    }
  });

  if (error) {
    console.error('provision_profile_as failed', error);
    return false;
  }

  return true;
}

/**
 * Authenticate a request and return a caller context.
 *
 * The returned client uses the service role, so the caller is trusted to have
 * done its authorisation — which is why every function in this directory starts
 * with `requireCaller` and then checks permissions explicitly.
 */
/**
 * Throw `RATE_LIMITED` when the caller is over quota.
 *
 * Takes the limit's name rather than the numbers, so the ceilings live in one
 * place (`_shared/rateLimit.ts`) instead of being restated per function and
 * drifting apart.
 */
export async function enforceRateLimit(
  caller: Caller,
  limitName: keyof typeof import('./rateLimit.ts').LIMITS,
): Promise<void> {
  const { limitFor, consumeRateLimit } = await import('./rateLimit.ts');
  const options = limitFor(limitName);

  const result = await consumeRateLimit(caller.clerkUserId, options);

  if (!result.allowed) {
    throw new RateLimitError(
      `Too many requests. Try again in ${result.retryAfterSeconds} second${
        result.retryAfterSeconds === 1 ? '' : 's'
      }.`,
      result.retryAfterSeconds,
    );
  }
}

/** Distinct from `AuthError` so the envelope carries a 429 and a retry hint. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** The caller's own `profiles` row, joined to its role name. */
interface CallerProfile {
  id: string;
  email: string;
  role_id: string;
  status: string;
  role_name: string | null;
}

/**
 * Read one caller's profile row.
 *
 * `runPrivileged` rather than `runAsCaller` because the caller's own RLS would reject
 * an unprovisioned or inactive account — and distinguishing those two from a valid
 * session is exactly why this read exists. The row is selected by an id that
 * `verifyClerkToken()` has already proved, so nothing in the request chooses which row
 * is returned.
 *
 * Direct Postgres rather than PostgREST. Timing this is what identified the cost: with
 * no token a request returned in ~240ms, and a wrongly-signed token — which still
 * fetches the JWKS and verifies a signature — in ~270ms. Every authenticated request
 * then took 3–5 seconds. The signature verification was never the problem; the single
 * PostgREST round trip to read this row was, and it sat on the hot path of all fifteen
 * functions.
 */
function readProfile(clerkUserId: string): Promise<CallerProfile | null> {
  return runPrivileged(async (sql) => {
    const rows = await sql.query<CallerProfile>(
      'select p.id, p.email::text as email, p.role_id, p.status, r.name as role_name ' +
        'from public.profiles p ' +
        'left join public.roles r on r.id = p.role_id ' +
        'where p.id = $1',
      [clerkUserId],
    );

    return rows[0] ?? null;
  });
}

export async function requireCaller(request: Request): Promise<Caller> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');

  if (!token) {
    throw new AuthError('UNAUTHENTICATED', 'You must be signed in to do that.');
  }

  const clerkUserId = await verifyClerkToken(token);
  let profile = await readProfile(clerkUserId);

  if (!profile) {
    // Clerk lets anyone sign up, so an account with no `profiles` row is a normal
    // first sign-in rather than an error. Create the profile and carry on.
    //
    // The email is resolved by asking Clerk, not read from the token. A Clerk
    // session token carries only `azp, exp, fva, iat, iss, nbf, sid, sts, sub, v` —
    // there is no `email` claim unless the instance is explicitly configured to add
    // one — while `profiles.email` is NOT NULL. A user signing in with Google was
    // therefore authenticated correctly and still could not be provisioned.
    //
    // `provision_profile_as` is granted to `service_role` only, so the browser
    // cannot supply an arbitrary id or email; both values here are the ones Clerk
    // reports for the id `requireCaller()` already verified.
    const provisioned = await provisionFromClerk(clerkUserId);

    if (!provisioned) {
      throw new AuthError(
        'FORBIDDEN',
        'Your sign-in account has no email address, so a school profile cannot be created. ' +
          'Add an email address in your account settings, then sign in again.',
      );
    }

    // Re-read rather than trusting what provisioning reported to have inserted: this
    // is the one place the caller's identity, role and status are resolved, and it
    // must reflect exactly what the database holds.
    profile = await readProfile(clerkUserId);
  }

  const resolved = profile;

  if (!resolved) {
    throw new AuthError(
      'FORBIDDEN',
      'Your account has not been added to this school yet. Ask an administrator for access.',
    );
  }

  if (resolved.status !== 'active') {
    throw new AuthError('FORBIDDEN', 'Your account has been deactivated.');
  }

  return {
    clerkUserId,
    email: resolved.email,
    role: resolved.role_name ?? 'teacher',
    supabase: createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ),
  };
}

/**
 * Assert a permission, using the same `has_permission()` the RLS policies read.
 *
 * Calling the database function rather than re-deriving the role matrix in
 * TypeScript means there is exactly one definition of what a role can do — the
 * one that actually enforces it.
 */
/**
 * Assert a permission.
 *
 * Calls `has_permission_for()` — the service-role variant — rather than
 * `has_permission()`. Under the service role there is no `auth.jwt()`, so the
 * no-argument version would resolve `current_clerk_id()` to NULL and deny
 * everyone. Passing the subject explicitly is what makes the check meaningful
 * here.
 */
export async function requirePermission(caller: Caller, permission: string): Promise<void> {
  if (!(await hasPermission(caller, permission))) {
    throw new AuthError('FORBIDDEN', 'You do not have permission to do that.');
  }
}

export async function hasPermission(caller: Caller, permission: string): Promise<boolean> {
  const { data, error } = await caller.supabase.rpc('has_permission_for', {
    p_user_id: caller.clerkUserId,
    perm: permission,
  });

  // Fail closed: an error must never be read as "allowed".
  if (error) {
    console.error('has_permission_for failed', error);
    return false;
  }

  return data === true;
}

/**
 * Assert the caller is assigned to this section + subject + year.
 *
 * The row-level counterpart to `assignment:manage`. Storage RLS cannot express
 * "assigned to this section", which is why every function that hands out a signed
 * URL for an uploaded mark sheet must call this explicitly.
 */
export async function requireAssignment(
  caller: Caller,
  scope: { sectionId: string; subjectId: string; academicYearId: string },
): Promise<void> {
  if (!(await isAssignedTo(caller, scope))) {
    throw new AuthError('FORBIDDEN', 'You are not assigned to this class.');
  }
}

export async function isAssignedTo(
  caller: Caller,
  scope: { sectionId: string; subjectId: string; academicYearId: string },
): Promise<boolean> {
  const { data, error } = await caller.supabase.rpc('is_assigned_for', {
    p_user_id: caller.clerkUserId,
    p_section: scope.sectionId,
    p_subject: scope.subjectId,
    p_year: scope.academicYearId,
  });

  if (error) {
    console.error('is_assigned_for failed', error);
    return false;
  }

  return data === true;
}

/**
 * May this caller read this OCR document?
 *
 * Mirrors the retired `authoriseDocumentAccess()`: the uploader, anyone with
 * `ocr:view_all`, or a teacher assigned to the same section and subject. A
 * mark sheet is a list of individual scores, so the third case matters — a
 * teacher's `marks:view_assigned` must not become a way to read another
 * teacher's scan.
 */
export async function canReadDocument(
  caller: Caller,
  document: {
    uploaded_by: string;
    section_id: string;
    subject_id: string;
    academic_year_id: string;
  },
): Promise<boolean> {
  if (document.uploaded_by === caller.clerkUserId) return true;
  if (await hasPermission(caller, 'ocr:view_all')) return true;
  if (await hasPermission(caller, 'marks:view_all')) return true;

  return isAssignedTo(caller, {
    sectionId: document.section_id,
    subjectId: document.subject_id,
    academicYearId: document.academic_year_id,
  });
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Append an audit row.
 *
 * Background work such as OCR runs as `system` rather than as a person, so
 * `audit_logs.user_id` stays nullable and is simply left null here. The audit
 * trail has to survive the account that produced it, which is why it is not a
 * foreign key.
 */
export async function audit(
  caller: Caller,
  entry: {
    action: string;
    entityType: string;
    entityId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  const { error } = await caller.supabase.from('audit_logs').insert({
    user_id: caller.clerkUserId,
    user_email: caller.email,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    old_value: entry.oldValue ? JSON.stringify(entry.oldValue) : null,
    new_value: entry.newValue ? JSON.stringify(entry.newValue) : null,
    reason: entry.reason ?? null,
  });

  if (error) {
    // An audit failure must not silently vanish, but it also must not fail the
    // user's action — the write already succeeded.
    console.error('audit write failed', error);
  }
}