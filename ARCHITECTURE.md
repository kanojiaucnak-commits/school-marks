# Architecture — Clerk + Supabase + GitHub Pages

This replaces the previous Cloudflare stack (Pages + Workers + D1 + R2), which has
been removed. `worker/` was deleted outright — **16,842 LOC** of Hono routes,
services, D1 repositories, OCR providers and tests.

---

## Status

| Check | Result |
|---|---|
| `npm run typecheck` | Passing (shared + frontend) |
| `npm run build` | Passing, `dist/404.html` emitted |
| `npm test` | Passing — **160 shared** (incl. Edge Function tests), **51 frontend** |
| SQL migrations applied | ✅ **All 16 applied to `nhqobdectcswnfmmyqtw` and verified** |
| Edge Functions deployed | ✅ 15 deployed to `nhqobdectcswnfmmyqtw`, all `ACTIVE`, `--no-verify-jwt` |
| Sign-in | ✅ Working end to end, browser-verified with a real Clerk session |
| Every page renders | ✅ Browser-verified as administrator against seeded data |
| Class & section CRUD | ✅ Rename and delete verified in the browser, against the live constraints |
| `data-proxy` auth + SQL layer | ✅ Verified against the live database (see below) |

### First sign-in, end to end

The path that had never run before, now verified with a real Clerk session and a real
Google sign-in account:

1. Clerk issues a session token. It carries **no `email` claim** — only
   `azp, exp, fva, iat, iss, nbf, sid, sts, sub, v` — because a Clerk instance only
   includes one when configured to. `profiles.email` is `NOT NULL`, so this used to
   make a correctly-authenticated user unprovisionable, reported as "your account has
   no email address".
2. `requireCaller()` finds no `profiles` row, calls the Clerk Backend API for the id
   the verified token named, and passes the result to `provision_profile_as()`.
3. The profile is created as `role_teacher`; the user is promoted to `role_admin` by an
   administrator, and immediately sees 41 permissions and every page.

`provision_profile_as()` is granted to `service_role` **only**. The browser cannot
supply a user id or an email to it, so the identity is always the one `requireCaller()`
cryptographically verified and the address is always the one Clerk reports.

### A note on request latency

Every authenticated request costs roughly **3.5 seconds**, and a page that chains two
queries therefore takes 7–14 seconds to settle. Signature verification is *not* the
cost — measured at ~270ms, against ~240ms for a request rejected before any work.
The remainder is the Edge runtime reaching a database in `ap-northeast-2`.

Two things were measured and one conclusion drawn:

| Path | Latency |
|---|---|
| No token (rejected immediately) | ~240ms |
| Wrongly-signed token (JWKS fetched, signature checked) | ~270ms |
| Valid token, plus the database round trip | ~3,500ms |

`db.<ref>.supabase.co` resolves to **AAAA only** on this project, so the runtime has no
usable IPv6 route to it. Routing through `PG_POOLER_HOST` (the IPv4 pooler) fixes that
and requires a tenant-qualified username — `postgres.<ref>`, because the pooler is
Supavisor and refuses a bare `postgres` with
`ENOIDENTIFIER no tenant identifier provided`. See `_shared/pooler.ts`.

That change did **not** deliver the speed-up it first appeared to: an early measurement
of ~1,100ms was a fast failure, not a fast success. The latency is unresolved and is the
largest outstanding problem in the application.

### Verified against the live database

Queried on the real project, not assumed:

| Property | Result |
|---|---|
| Tables in `public` | 34 |
| RLS policies | 55 |
| Functions | 79 |
| Views | 12 |
| Roles seeded | 3 (admin, teacher, reviewer) |
| `role_permissions` | 73 = admin 41 + reviewer 17 + teacher 15 |
| Grading scheme + rules | 1 + 7 (A+ … F) |
| Settings | 7 |
| Anonymous read of `profiles` / `marks` / `roles` / `audit_logs` | **0 rows — RLS enforcing** |
| `UPDATE`/`DELETE` on `audit_logs` | **Refused: `P0001: audit_logs is append-only`** |
| `marks_derive_grade`, `bump_submission_version`, `prevent_self_role_escalation`, both audit triggers | Present |
| `handle_new_user` on `auth.users` | Present |

The permission counts match `ROLE_PERMISSIONS` in `shared/src/permissions.ts`
exactly, so the parity test in `shared/tests/permissions.seed.test.ts` is now
validated against a real database rather than only against itself.

### `data-proxy` — why the browser does not talk to PostgREST

This is the one place the design departs from the obvious approach, so the
reasoning is recorded in full.

Clerk is the identity provider. The browser therefore holds a Clerk session token
and hands it to Supabase on every request — which is what PostgREST expects. It
does not work, and the reason is not obvious from the error:

```
PGRST301  "No suitable key or wrong key type"
```

PostgREST verifies bearer tokens itself, against `PGRST_JWT_SECRET`. Supabase sets
that through container configuration, and the only key it publishes is its own
ES256 one:

| | Algorithm | Key |
|---|---|---|
| Project JWKS | ES256 | `f99dd48a…` |
| Clerk tokens | **RS256** | `ins_3KEE6D9tsoFsGfn3eNMKPOdxaJn` |

So PostgREST cannot verify a Clerk token, and neither can Supabase Storage — which
is why `storage().from(…).createSignedUrl()` had to go too; downloads now go
through the `export-download` function, which checks permission and signs in one
step.

Four fixes were attempted before concluding it was not a configuration mistake:

| Attempt | Result |
|---|---|
| Clerk domain added in the dashboard | JWKS unchanged; still `PGRST301` |
| `[auth.third_party.clerk]` + `supabase config push` | `email.enable_signup` flipped, so the push worked — but `third_party` was silently never transmitted |
| Mint Supabase-signed tokens locally | Project JWT secret unobtainable: not via the Management API, not in the database, `vault.decrypted_secrets` empty |
| Point `pgrst.jwt_secret` at a merged JWKS served by a function | Override not honoured — Supabase sets it via the environment, which wins |

**What `data-proxy` does instead.** It connects to Postgres directly over the
auto-injected `SUPABASE_DB_URL` and impersonates the caller *inside the database*:

```sql
BEGIN;
SET LOCAL ROLE authenticated;          -- not service_role, so no BYPASSRLS
SELECT set_config('request.jwt.claims', '{"sub":"user_…"}', true);
SELECT … ;                             -- the caller's real policies apply
COMMIT;
```

Using the service role would have been far easier and is exactly wrong: it has
BYPASSRLS, so no policy would run and the repository would become the only thing
authorising access. `authenticated` is what PostgREST itself uses, and
`request.jwt.claims` is the GUC PostgREST populates, so **every policy in
`0002_rls.sql` evaluates unchanged**. The proxy decides which statement to run; it
never decides what the caller may see.

### SQL is built against the live catalogue

`_shared/sql.ts` builds every statement. Identifiers cannot be parameterised in
Postgres, so table, column and function names are validated against
`information_schema` and `pg_proc` before reaching the SQL text — an allowlist
drawn from the real schema, not escaping. Values are always bound parameters;
there is no value interpolation anywhere.

### What was verified, and how

A temporary self-test function exercised the real `buildQuery` and `runAsCaller`
modules — not copies — because a valid Clerk session token cannot be forged for
testing. It found two bugs that would otherwise have shipped: the pool accessor is
`getConnection`, not `get`, and the driver returns a non-array result shape. Both
now probe for the method instead of assuming.

| Check | Result |
|---|---|
| `current_user` during a proxied query | `authenticated` |
| `current_clerk_id()` | the caller |
| Teacher reads `students`, no assignments | **0 rows** |
| Admin reads `students` | 1 row |
| Teacher inserts a student | **refused: "new row violates row-level security policy"** |
| `eq` / `is null` / `in` / `or=` / order / limit / `count: exact` | correct |
| `rpc('my_profile')` through the proxy | full profile, 41 admin permissions |
| Value `' ; drop table students; --` | 0 rows — bound, not executed |
| Table `students; drop table marks` | rejected: unknown relation |
| Column `1) as x(--` | rejected: unknown column |
| `or=` fragment with `' or 1=1 --` | 0 rows — bound, not executed |
| Unknown function / unknown RPC argument | rejected |
| `information_schema.tables` afterwards | 34 — nothing dropped |

The self-test and its seed data were removed afterwards. Writes are covered only by
the negative case above: no test exercised a *successful* insert through the proxy,
because doing so needs a permission grant and a cleanup path in the same test.

### Unit tests for the Edge Function sources

`supabase/functions/_shared/` is written for Deno and imports `npm:fflate` and
`jsr:@db/postgres`, neither of which resolves under Node — so `xlsx.ts` and
`sql.ts`, the two modules most likely to be subtly wrong, had no coverage at all and
had never been executed. `shared/vite.config.ts` now aliases the versioned Deno
specifier to the real `fflate`, so the workbook is genuinely zipped in tests rather
than stubbed.

Two real bugs were found by writing them, both invisible to the live self-test:

- **`getRpcArgs` read the wrong column.** It selected `p.proname as name` — the
  *function* name — where it meant `u.name`, the *argument* name. Every named RPC
  through the proxy would have failed with "Unknown argument". The self-test missed
  it because `my_profile()` takes no arguments, so the faulty branch was never
  reached.
- **The embedded-resource link column was guessed** by singularising the table name,
  giving `profile_id` where this schema uses `teacher_id`. The syntax now accepts
  PostgREST's `alias:table!link_column(cols)` so the caller states it, and the guess
  is only a fallback. A wrong guess would otherwise have produced a correlated
  subquery against the wrong column.

60 tests cover the two modules: archive structure and part names, numeric cells
versus inline strings (a sheet of text marks that sums to zero is the quiet failure
here), XML escaping, control characters, sheet-name sanitisation, plus the SQL
allowlist, parameterisation of every injection attempt, filter and ordering
construction, and RPC argument binding.

### Self-service onboarding (migration 0008)

Anyone can sign up in Clerk, so accounts are no longer created by an
administrator. That inverts the old model, and one part of it did not survive the
inversion intact.

`students_read` used to be school-wide for anyone holding `student:view`, which
all three roles have. That was safe while an admin created every account by
hand; once the public internet can create them, every self-registered teacher
would see the whole roster. It is now split the same way marks already were:

| Permission | Held by | Grants |
|---|---|---|
| `student:view_all` | admin, reviewer | every student |
| `student:view` | all three | only students in assigned sections |

The flow is:

1. **Sign up.** `provision_current_profile()` creates a `profiles` row on first
   authenticated call. It derives the subject from the verified Clerk `sub` in
   the JWT rather than from a parameter, and hard-codes `role_teacher` — there is
   deliberately no argument through which a caller could choose a role or
   provision somebody else. `handle_new_user` cannot do this job: it hangs off
   `AFTER INSERT ON auth.users`, which only fires for Supabase Auth signups.
2. **Request.** `request_assignment(year, class, section, subject)` verifies the
   class/section/year triple is internally consistent and refuses duplicates.
3. **Approve.** `decide_assignment_request()` writes the `teacher_assignments`
   row in the same transaction as the status change, so an approved request can
   never exist without the access. This is the same table `AssignmentsPage`
   writes by hand, so there is one mechanism, not two.

An unassigned teacher is inert by construction: every data-bearing policy routes
through `is_assigned_to()`, which requires a real `teacher_assignments` row. They
can read the class/subject directory — needed to make a request — and nothing
else. Verified against the live database with a simulated Clerk session:

| Probe, teacher with zero assignments | Result |
|---|---|
| `role` granted by provisioning | `role_teacher` |
| classes / sections / subjects | 1 / 2 / 2 readable |
| students | **0** |
| `can_read_sheet` | `false` |
| `assignment:decide` | `false` |
| After admin approval: students | **only the assigned section's** |
| After approval: `can_read_sheet` for the approved slot / an unrequested one | `true` / `false` |

> **The Edge Functions are deployed and reachable, but only their auth path has been
> exercised.** All 14 bundle and report `ACTIVE`, which means every import resolves
> and every file parses. Their business logic — OCR, XLSX, reports, imports — has
> still never executed, because doing that needs a signed-in Clerk session.

### Auth verified against the live endpoint

`ocr-providers` was probed with hand-built JWTs. Every attack was rejected:

| Attack | Response |
|---|---|
| `alg: none` downgrade | `Unsupported token signature algorithm.` |
| `alg: HS256` confusion (sign with the public RSA modulus) | `Unsupported token signature algorithm.` |
| Real Clerk `kid`, garbage signature, `sub` forged as a user id | `Your session could not be verified.` |
| Unknown `kid` | `Your session has expired.` |
| Header with no `kid`, non-JWT, wrong segment count | `Malformed session token.` |

The third row is the one that matters. An earlier version of `_shared/auth.ts`
called `decodeJwt()` from `jose`, which *parses* a token without checking its
signature; combined with a `kid` lookup against the public JWKS, anyone could
have hand-written a token whose `sub` was an administrator's Clerk user id and been
believed. Every function trusts that `sub` for profile lookup, ownership checks
and audit rows, so it would have been full compromise. It now verifies the
signature with WebCrypto — no JWT library, therefore no library to keep patched.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind, TanStack Query, React Hook Form + Zod, Recharts |
| Auth | Clerk — sessions, password resets, user management |
| Data | Supabase Postgres, with Row Level Security as the authorisation boundary |
| Files | Supabase Storage, private buckets, signed URLs |
| Server work | Supabase Edge Functions (Deno) — OCR, reports, exports, imports |
| Hosting | GitHub Pages (static SPA) |

---

## Layout

```
frontend/src/lib/
  auth.tsx          Clerk + profiles bridge; four auth states
  supabase.ts       Clerk-authenticated Supabase client (PostgREST)
  edge.ts           Edge Functions client (token + envelope + downloads)
  query.ts          QueryError, pagination, camelCase mapping
  queryClient.ts    Retry policy keyed on Postgres SQLSTATEs
  repos/            academic, students, marks, admin, storage
supabase/
  migrations/       0001 schema · 0002 RLS · 0003 seed · 0004 RPCs
                    0005 session read model · 0006 views · 0007 rate limits
  functions/        14 Edge Functions + _shared/
shared/
  permissions.ts    permission catalogue + role matrix (rendering)
  tests/            permission-seed parity, CSV contract
```

---

## What replaced what

| Was (D1 + Worker) | Is now |
|---|---|
| D1 tables, `TEXT` ids | Postgres `uuid` + `gen_random_uuid()` |
| ISO-8601 `TEXT` timestamps | `timestamptz` |
| `INTEGER CHECK (x IN (0,1))` | `boolean` |
| `REAL` marks and percentages | `numeric(6,2)` — exact decimals |
| JSON stored in `TEXT` columns | `jsonb` |
| `COLLATE NOCASE` on email | `citext` |
| `sessions`, `password_reset_tokens`, `login_attempts` | **Deleted.** Clerk owns all of it |
| `users` table | `profiles`, keyed by Clerk user id |
| `requirePermission()` in Worker middleware | RLS policies in Postgres |
| `db.batch()` for atomicity | Postgres functions (one statement = one transaction) |
| `GradingEngine` (115 LOC TypeScript) | `marks_derive_grade()` trigger |
| Private R2 bucket | Private Storage buckets + signed URLs |
| Cloudflare Queues | Inline generation, with a queue threshold |
| `_redirects` on Cloudflare Pages | `dist/404.html` (Pages has no rewrite rules) |

---

## The ten business rules

Each names the element that enforces it, because a rule that only lives in a React
component is not a rule.

| # | Rule | Enforced by |
|---|---|---|
| 1 | OCR-extracted marks are **never** final; ambiguous matches are never auto-assigned | `ocr_results.verified` defaults `false`; `ocr-confirm` requires `markReviewed: true`; `matchRow()` refuses ambiguous rows |
| 2 | A teacher sees **only** students assigned to them | `is_assigned_to()` / `can_read_sheet()` in `0002_rls.sql` |
| 3 | Teachers **cannot** modify locked marks | `submissions_owner_update` policy; `marks:correct_locked`; `save_marks_grid()` returns `SUBMISSION_NOT_EDITABLE` |
| 4 | A mark can **never** exceed the exam maximum | `chk_marks_within_max` **and** an explicit check in `save_marks_grid()` |
| 5 | Everything is auditable | `audit_logs` + `deny_audit_mutation()` triggers |
| 6 | Data is never silently overwritten | Optimistic concurrency (`version` bumped by trigger) + `old_value`/`new_value` JSONB |
| 7 | Student names are never primary keys | `students.id uuid DEFAULT gen_random_uuid()`; `UNIQUE (academic_year_id, student_number)` |
| 8 | Authorisation is enforced **server-side** | RLS on every table — now in the database, so it holds against a direct PostgREST call |
| 9 | Private documents are never publicly accessible | Storage buckets `public = false`; `ocr-file-url` re-checks the assignment scope |
| 10 | Historical academic-year records stay intact | Promotion inserts a new row; `student_number` unique per year |

---

## Design decisions worth knowing

**RLS is the enforcement boundary.** Strictly stronger than middleware: a bug in an
Edge Function cannot read a row it shouldn't. `current_role()` reads the live
`profiles` row rather than the JWT claim, so revoking an admin takes effect on the
next statement instead of after a Clerk token refresh.

**Edge Functions re-check permissions themselves.** They use the service role to
mint signed URLs and write to Storage, which bypasses RLS — so every function calls
`requireCaller()` and then checks explicitly. `has_permission_for()` takes the
caller as an argument because under the service role `auth.jwt()` is empty and a
defaulted version would answer "no permission" for everybody.

**All RPCs are `SECURITY INVOKER`.** RLS still applies inside them. Marking them
`SECURITY DEFINER` would silently disable the entire authorisation model.

**`version` is bumped by a trigger, not by the caller.** Two concurrent writers
cannot both believe they produced version N+1, and *any* update invalidates an open
editor's expected version.

**"PDF" still means HTML + the browser's print dialog**, as it always has here.
`export-generate` and `report-generate` name those files `*.html` rather than
faking a PDF. XLSX *is* a real workbook (hand-rolled OOXML, ported verbatim).

**Rate limiting is a Postgres table.** The retired `Map` was per-isolate and
therefore already unreliable. `consume_rate_limit()` increments atomically so
concurrent requests cannot both pass the limit.

---

## The `unprovisioned` state

A state the hand-rolled auth could not produce. Clerk owns identity and `profiles`
owns the school record, so they can disagree: an account created but never
provisioned, or a profile set to `inactive`.

Redirecting these to sign-in would loop forever. `RequireAuth` therefore has four
states — `loading`, `anonymous`, `unprovisioned`, `authenticated` — and
`AccountUnavailablePage` explains the situation rather than offering a retry.

---

## Setup

### Clerk

1. Create an application at <https://dashboard.clerk.com>.
2. Disable email/password signup — accounts are provisioned by an administrator.
3. `VITE_CLERK_PUBLISHABLE_KEY` → `frontend/.env.local`.
4. Add `http://localhost:5173` and `https://<user>.github.io` to **Allowed Origins**
   and **Redirect URLs**.
5. Set a user's `public_metadata.role` to `admin`, `teacher` or `reviewer`.
   `handle_new_user()` reads it on first sign-in; unknown values fall back to
   `role_teacher`, never admin.

### Supabase

```bash
npm install -g supabase
supabase link --project-ref <your-ref>
supabase db push
supabase secrets set CLERK_ISSUER=https://<your-app>.clerk.accounts.dev
supabase functions deploy --no-verify-jwt   # see below, the flag is required
```

`CLERK_ISSUER` must be the **Frontend API** domain — the one encoded in your
`pk_test_…` publishable key, decoded from base64. It is not always the same string
as the dashboard's app name, so decode the key rather than retyping it:

```bash
node -e "console.log(Buffer.from(process.argv[1].split('_')[2],'base64').toString())" <publishable-key>
```

Two things about the deploy flag:

- **`--no-verify-jwt` is required.** The gateway only understands tokens signed
  with the project's own JWT secret. Clerk tokens are not, so with verification on
  the gateway rejects every request with a bare bodyless 401 before any function
  code runs. Each function verifies the Clerk token itself instead.
- **`SUPABASE_SERVICE_ROLE_KEY` needs no action.** Supabase injects it, along with
  `SUPABASE_URL` and `SUPABASE_ANON_KEY`, automatically.

Required secrets:

| Secret | Needed by |
|---|---|
| `CLERK_ISSUER` | all functions |
| `CLERK_SECRET_KEY` | `admin-create-clerk-user` |
| `OCR_PROVIDER` | `ocr-process` (`google` \| `azure` \| `textract` \| `manual`) |
| `GOOGLE_VISION_API_KEY` | Google provider |
| `AZURE_VISION_ENDPOINT`, `AZURE_VISION_KEY` | Azure provider |
| `AWS_TEXTRECT_ACCESS_KEY_ID`, `AWS_TEXTRECT_SECRET_ACCESS_KEY`, `AWS_REGION` | Textract provider |

Enable Clerk as a third-party JWT issuer under **Authentication → Providers →
Third-party Auth → Clerk**.

### Local development

```bash
npm install
supabase start
supabase functions serve --env-file supabase/.env.local
npm run dev
```

### Environment

```
frontend/.env.local
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
  VITE_SUPABASE_URL=https://<ref>.supabase.co
  VITE_SUPABASE_ANON_KEY=...
  VITE_APP_ORIGIN=http://localhost:5173
```

The anon key is safe in the browser: every table is behind RLS and an
unauthenticated request resolves to zero rows. **Never** put `service_role` in a
`VITE_` variable — it bypasses RLS entirely.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite on :5173 |
| `npm run build` | typecheck + build + emit `dist/404.html` |
| `npm run typecheck` / `npm test` | shared + frontend |
| `npm run db:migrate` | `supabase db push` |
| `npm run db:reset` | `supabase db reset` (drops, re-migrates, re-seeds) |
| `npm run functions:serve` | `supabase functions serve` |

---

## GitHub Pages

`.github/workflows/deploy.yml` typechecks, tests, builds and deploys, then pushes
migrations and functions. Requires secrets `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`.

Pages serves from `https://<user>.github.io/<repo>/`, so `VITE_BASE_PATH` must
include the repository name. Pages has no `_redirects` equivalent, so a deep link
like `/app/students` is served by `dist/404.html` — the build writes it and CI
asserts it exists, because a missing file breaks direct navigation in production
only.

---

## Known gaps

**Blocking before production**

- **Edge Functions compile, but OCR, report and import code paths have still never
  run.** Auth and the SQL layer are proven; the rest need a real signed-in session.
- **`CLERK_SECRET_KEY` is unset**, so `admin-create-clerk-user` 500s. Every other
  function has its secrets.
- **Textract has no test coverage and its SigV4 signer is hand-rolled.** Google and
  Azure paths are unverified against the live APIs.
- **No E2E tests and no page-level tests.** `MarkCell.test.tsx` covers one component;
  `xlsx.ts` and `sql.ts` are now covered, but no page or hook is.
- **Still no super admin exists.** Self-service provisioning grants `role_teacher`,
  so the first account to sign up is a teacher with no classes. Promote yourself
  once, by hand:
  `update public.profiles set role_id = 'role_admin' where email = 'you@example.com';`

  This is deliberately a manual step rather than an automatic "first user becomes
  admin" rule: that rule would hand super-admin to whoever happened to sign up
  first, on a publicly reachable sign-up form.

**Non-blocking**

- `listSubmissions` caps at 200 rows with client-side paging, so the reviewer queue
  total is not a true count beyond that.
- `updateExam`, `deleteExam`, `updateSection`, `deleteSection` have repo functions
  but no UI.
- `ReviewQueuePage` runs an effect to set page size 20 because the hook defaults to
  25.
- Dead exports worth deleting: `canAll`, `canAny`, `isAdmin`, `reviewsMarks`,
  `useCurrentUser`, `utils.hasPermission`, `crudApi`, `useResourceMutation`,
  `useAsyncAction`, `api.url`.
- No route-level permission guards — access control is navigation filtering plus
  in-page `can()`. RLS is the real boundary, but a user can still navigate to a URL
  they lack permission for and see an error state.

---

## Bugs found by exercising the running application

Every bug in this section was invisible to typecheck, to the test suite, and to a
green deployment. They were found by signing in with a real account and clicking
through the pages. That is the argument for doing it.

### The repeated theme: an assumed third-party shape

Three separate defects had the same cause — code written against what a response
*probably* looked like rather than what it *does* look like. Two of the first two were
caught earlier by tests; the third was not caught by anything and locked every user out.

- **Clerk's user object.** Provisioning read `primary_email_address.email_address` and
  `email_address`. Neither exists: the address lives in **`email_addresses`** (a plural
  array), the singular field is `null`, and `primary_email_address` is *not expanded* in
  a plain `GET /v1/users/{id}` response — only `primary_email_address_id` is present. So
  a user with a verified email was reported as having none, and could not be
  provisioned. `readClerkIdentity()` in `_shared/auth.ts` is now a separate, tested
  function, and `shared/tests/functions/clerk-identity.test.ts` runs it against a
  **real captured response** rather than a shape I invented.
- **`getRpcArgs`** selected `p.proname` — the function's *name* — where it needed
  `u.name`, the argument's name. Every named RPC was broken.
- **Embedded-resource link columns** were guessed by singularising the table name, so
  `sections` linked on `profile_id` instead of the real `teacher_id`. Now
  `alias:table!link_column(cols)`.
- **The Postgres driver's error object.** `@db/postgres` does not spread the database's
  error fields onto the error; it nests them:

  ```ts
  PostgresError {
    message,
    fields: { severity: 'ERROR', code: '23503', message, detail,
              schema, table, constraint, file, line, routine },
    query,
  }
  ```

  Both `handle()` and `data-proxy`'s own catch read `caught.code`, where it does not
  exist. **Every database error in the application was therefore reported as
  `INTERNAL_ERROR` with the raw Postgres message**, and the client's `friendlyMessage()` —
  which maps 23503, 23505, 23514, 42501 and the rest — never matched anything. It
  surfaced as a raw constraint name in the interface:

  > update or delete on table "classes" violates foreign key constraint
  > "students_class_id_fkey" on table "students"

  `_shared/pgError.ts` now reads whichever location is present, preferring a real
  SQLSTATE over an application code so an `AuthError`'s `FORBIDDEN` is not overwritten.
  `shared/tests/functions/pg-error.test.ts` pins it against the **captured driver
  error**, including an assertion that `caught.code` is `undefined` — the reason the bug
  existed.

  Two consequences followed. `23502` had no mapping at all, so a missing required value
  reached the user verbatim as
  `null value in column "name" of relation "classes" violates not-null constraint`,
  naming the table. And `QueryError` discarded the raw message in favour of the friendly
  one, so `fieldIssues` had nothing left to match a column against; it now keeps
  `rawMessage` alongside it.

### Other defects

- **`??` written into SQL.** Migration 0013 contained
  `v_name := nullif(...) ?? split_part(...)`. `??` is JavaScript, not SQL. PL/pgSQL does
  not parse a function body's expressions until it runs, so `CREATE FUNCTION` succeeded
  and reported nothing — and every call then died with `operator does not exist: text ?? text`.
  The visible symptom was a message about Clerk not having an email address, when the
  email had been found perfectly well. Fixed in 0015, which now **asserts its own
  function's behaviour** across nine cases, because a function that throws on every
  call is invisible to the catalogue.
- **`BigInt` could not be serialised.** Postgres `int8` arrives as a JS `BigInt` and
  `JSON.stringify` refuses one, so **every query touching a `bigint` failed with a
  500** — which is every `count(*)`, including the administrator's entire dashboard.
  `_shared/json.ts` now converts BigInts to numbers, and to *strings* above
  `Number.MAX_SAFE_INTEGER` rather than rounding silently.
- **`head: true` was rejected.** The client speaks PostgREST and sent `columns: "1"` for
  a head count; `data-proxy` validates columns against the table and answered
  `Unknown column "1" on "v_directory"`. The projection is discarded for a head query
  anyway, so it is no longer built — and the client no longer sends PostgREST-specific
  syntax this protocol does not share.
- **Sign-in reported the wrong cause.** Already being signed in makes Clerk refuse the
  sign-in modal (`cannot_render_single_session_enabled`). That was surfaced as "the
  window could not be opened"; it now redirects onward. `clerk.openSignIn` is also not
  referentially stable, so listing it as an effect dependency re-fired the effect every
  render and toggled the modal open/closed until it never appeared.
- **`normalized_name` had no single definition.** It is `NOT NULL` with no trigger, so
  every write path must supply it, and `import-commit`'s own comment warns that a
  divergence from `normalizeName()` means OCR matching silently stops matching. Seeding
  students required transcribing it by hand. `public.normalize_name()` (0016) is now
  the SQL side, `seed.sql` calls it, and **both sides pin the same ten cases** — the
  migration asserts them in SQL, `shared/tests/normalize-name.test.ts` in TypeScript.
  Neither `\s` nor `\p{L}` is valid in a Postgres ARE; the POSIX classes are.

### The delete dialogs asserted things the database does not do

"Cannot delete or update classes" turned out to be three separate defects, and the
warnings the UI showed while refusing were themselves wrong — which is worse than no
warning, because they send the user looking for the wrong thing.

- **A class could be created and deleted but never renamed.** `updateClass` existed in
  `repos/academic.ts` and was called from nowhere. Sections had a rename control;
  classes had none. A mistyped class name could only be worked around by deleting the
  class — which is impossible, because `students.class_id` is `ON DELETE RESTRICT`.
  The `renameSection` comment already described this exact dead end for sections.
- **The class dialog claimed marks were what blocked the delete** — *"Students cannot be
  deleted while they hold marks… If this class has students with marks, the delete will
  be rejected."* No student in the seeded data had a single mark, and every class was
  still refused: `RESTRICT` fires on the presence of a student, not on their marks.
- **It then recommended an option that does not exist** — *"Consider marking a class
  inactive instead."* `classes` has no `is_active` or `archived_at` column.
- **The section dialog promised data loss that never happens** — *"Deleting this section
  removes its students and mark sheets."* `students.section_id` is also
  `ON DELETE RESTRICT`, so the delete is **refused** and no marks are touched. A user
  reading this would reasonably avoid a delete that was in fact safe.

Both dialogs now state the constraint as the schema defines it, count the blocking
students up front rather than letting the server report it afterwards, and say what the
actual next step is. Verified against the live database: deleting a class of six
students is refused with *"That is still in use by a student, so it cannot be removed"*,
and an empty section deletes cleanly.

### The pooler forwards some error fields and drops others

Worth recording because it bounds what `detail` can be relied on for. Measured through
the transaction pooler this project must use:

| SQLSTATE | `detail` forwarded |
| --- | --- |
| `23503` foreign key | yes — `Key is still referenced from table "students".` |
| `23505` duplicate key | **no** (Postgres does send it) |
| `23502` not null | **no** (Postgres does send it) |

Confirmed by running the same statements through the Management API, which returns the
`DETAIL:` line the pooler drops. So `fieldIssues` and `friendlyMessage` parse `message`
as well as `details`; the column in a `23502` and the referrer in a `23503` are each
available from at least one of the two. Where neither is available the code falls back
to wording that does not name a table, which is asserted by a test.

---

## Pre-existing bugs found during the migration

Documented rather than silently fixed:

- **Sign-in rendered a blank page.** `<SignIn routing="path" />` produced an empty
  `<div data-clerk-component="SignIn">` — no form, no inputs, no error, no console
  message — because the routed component resolves its path against the router
  `basename`. Confirmed by contrast on the same page: the routed component gave 0
  inputs while `Clerk.openSignIn()` gave `.cl-modalBackdrop` and 2 inputs. Both
  `/sign-in` and `/sign-up` now open Clerk's UI imperatively
  (`components/auth/ClerkModals.tsx`) while keeping the URLs working as routes.
  Three things had to be right, each found the hard way:
  1. `openSignIn()` is a silent no-op until Clerk has loaded, so the call is gated
     on `useAuth().isLoaded` — otherwise the fix reproduces the original blank page.
  2. Clerk v6 **removed** `afterSignInUrl`; the replacements are
     `signInForceRedirectUrl` / `signUpForceRedirectUrl` and are not interchangeable.
  3. `BrowserRouter` needed a `basename` (see below), which is what put the routed
     components in a state where they silently produced nothing.

  `frontend/src/test/clerk-auth.test.ts` pins all of this statically.
- `useCrudMutation` accepted no `mutationFn`, so **all 9 mutations** across
  `TeachersPage`, `AcademicYearsPage` and `SubjectsPage` were inert. Fixed by making
  `mutationFn` required, which turns that class of bug into a compile error.
- `SubjectsPage.remove.mutate()` passed the URL path instead of the id. Fixed.
- `AcademicYearsPage.submitInnerForm()` looked up a form with no `id` — the Create
  button did nothing. Fixed.
- `OcrReviewPage` rendered `document.subjectName`, which the D1 repository never
  selected, so it was always empty. Fixed by adding the field and supplying it from
  `v_ocr_documents`.
- `academicRepo.listExams` had `ORDER BY start_date = academic_year_id`. The repo is
  gone; the port uses `ORDER BY exam_date`.
- `marksService.resolveSheetTeacherId` was dead code. Gone with the repo.
- **`listSubmissions` capped at 200 rows and paged in the browser**, so sheets past
  the cap were absent from the reviewer queue rather than merely on a later page, and
  the total was wrong. Now paged in Postgres via `paginateSubmissions`.
- **`updateExam`, `deleteExam`, `updateSection` and `deleteSection` existed in the
  repository with no way to reach them.** An exam could be created but never
  corrected, and a mistyped section name could only be worked around by deleting and
  recreating the class — which takes its students with it. All four now have UI.
- **`updateOwnProfile`/`provisionUser` had two stacked doc comments** describing
  different things, one of them stale. Merged.
- **`canAll`, `canAny`, `isAdmin` and `reviewsMarks` were dead exports** in
  `lib/permissions.ts`, each referenced only at its own definition. Removed; role
  checks were the more likely of the two to go stale, and `can()` is answered by the
  same permission list RLS reads.
- **`BrowserRouter` had no `basename`.** The app is served from
  `https://<user>.github.io/<repo>/`, so `/school-marks/` matched no route and the
  landing URL rendered the 404 page — the app booted and then denied its own root
  existed. Would have done the same on GitHub Pages.
- **The landing page said "Access is by invitation."** Contradicted by self-service
  signup and the class-request flow added in 0008.

---

## Licence

See the repository's licence file.