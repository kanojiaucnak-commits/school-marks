# School Marks Management System

A school examination marks system: teachers enter and submit marks, reviewers
approve and lock them, and every step is audited.

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind, TanStack Query, React Hook Form + Zod, Recharts |
| Auth | Clerk — sessions, password resets, user management |
| Data | Supabase Postgres, with Row Level Security as the authorisation boundary |
| Files | Supabase Storage, private buckets, signed URLs |
| Server-side work | Supabase Edge Functions (Deno) — OCR, reports, exports, imports |
| Hosting | GitHub Pages (static SPA) |

> **Migrated from Cloudflare.** The Workers + D1 + R2 stack has been removed
> (16,842 LOC). Clerk owns authentication, Supabase Postgres owns the data with
> Row Level Security as the authorisation boundary, Edge Functions own OCR and
> exports, and GitHub Pages serves the SPA.
>
> See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design, the setup steps and
> an honest list of what has and has not been executed.
>
> **New here?** Follow **[docs/signup-walkthrough.md](./docs/signup-walkthrough.md)**
> for a step-by-step guide to signing up, requesting classes and getting access.

---

## The ten business rules

These are the requirements the system is built around. Each one names the code or
schema element that enforces it, because a rule that only lives in a React
component is not a rule.

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | OCR-extracted marks are **never** final. A human must verify every row, and ambiguous student matches are never auto-assigned. | `ocr_results.verified` defaults `false`; `ocr:confirm` permission on the confirm path; `supabase/functions/ocr-process/index.ts` refuses to auto-assign when the best and runner-up candidate scores are within `AMBIGUITY_MARGIN` |
| 2 | A teacher can see **only** students assigned to them. | `is_assigned_to()` / `can_read_sheet()` in `supabase/migrations/0002_rls.sql`, applied by the `marks`, `mark_submissions` and `ocr_documents` policies |
| 3 | Teachers **cannot** modify locked marks. Only a reviewer may, and only with a written reason. | `submissions_owner_update` policy requires an editable status; `marks_update_locked` policy requires `marks:correct_locked`; `save_marks_grid()` returns `SUBMISSION_NOT_EDITABLE` |
| 4 | A mark can **never** exceed the exam maximum. | `chk_marks_within_max` CHECK constraint, **and** an explicit range check inside `save_marks_grid()` |
| 5 | Everything is auditable. | `audit_logs` plus `deny_audit_mutation()` triggers that `RAISE EXCEPTION 'audit_logs is append-only'` |
| 6 | Data is never silently overwritten. | Optimistic concurrency (`version` on the sheet, conflict returned on mismatch) and `old_value`/`new_value` JSONB in every audit row |
| 7 | Student names are never used as primary keys. | `students.id` is `uuid DEFAULT gen_random_uuid()`; `UNIQUE (academic_year_id, student_number)` |
| 8 | Authorisation is enforced **server-side**. | RLS policies on every table — now in the database itself, so it holds even against a direct PostgREST call from the browser |
| 9 | Private documents are never publicly accessible. | Storage buckets created with `public = false`; `storage.objects` policies scope reads to the owner or `ocr:view_all` |
| 10 | Historical academic-year records stay intact. | Promotion creates a **new** student row; nothing rewrites a prior year's marks |

---

## How the guarantees are enforced

The interesting part of this system is *where* each rule lives. Rules enforced
only in application code are one refactor away from breaking, so the load-bearing
ones are enforced by the database as well.

**A mark can never exceed the maximum — twice.**

```sql
constraint chk_marks_within_max check (marks_obtained is null or marks_obtained <= max_marks)
```

```sql
-- and again, inside the write path, so the error is a clear message
-- rather than a constraint violation:
if v_marks is not null
   and exists (select 1 from public.exams where id = p_exam_id and v_marks > max_marks) then
  raise exception 'Mark % exceeds the maximum for this exam', v_marks;
```

If a future code path forgets the check, Postgres still refuses the write.

**The audit log cannot be rewritten — by anyone.**

```sql
create or replace function public.deny_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;
```

Not just "the app doesn't update it" — the database itself aborts, for every role
including the table owner.

**Statuses cannot contradict the data.**

```sql
constraint chk_marks_status_consistency check (
  (status = 'PRESENT' and marks_obtained is not null) or
  (status <> 'PRESENT' and marks_obtained is null)
)
```

This is what stops a medical absence being recorded as a zero, which would
silently fail a student.

**Grades cannot disagree with the grading scheme.**

`marks_derive_grade()` is a `BEFORE INSERT OR UPDATE` trigger: it derives
`percentage`, `grade`, `grade_point` and `is_pass` from the active
`grading_schemes` row. No writer — browser, Edge Function or admin script — can
persist a mark whose grade contradicts the scheme an administrator configured.

**Exactly one current academic year.**

A partial unique index on `academic_years (is_current) WHERE is_current` makes
"two current years" a database error rather than a logic bug.

**Students are year-scoped.**

`UNIQUE (academic_year_id, student_number)` means promoting a student creates a
new row for the next year. Last year's result stays exactly as it was — that is
Business Rule 10.

**Teacher scoping is a row-level rule, not a role check.**

`marks:view_assigned` does not mean "has the teacher role". It resolves against
`teacher_assignments`:

```sql
create or replace function public.can_read_sheet(p_section uuid, p_subject uuid, p_year uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('marks:view_all')
      or public.is_assigned_to(p_section, p_subject, p_year);
$$;
```

This is why the role/permission matrix is duplicated in TypeScript (for rendering)
and in SQL (for enforcement), and why `shared/tests/permissions.seed.test.ts`
asserts the two never drift.

---

## Authorisation model

Roles come from Clerk's `public_metadata.role` and are mirrored into `profiles`:

| Role | Sees |
| --- | --- |
| `admin` | everything |
| `reviewer` | all marks, approves / returns / locks, manages grading |
| `teacher` | only sections and subjects in `teacher_assignments` |

Two design decisions worth knowing:

- **`current_role()` reads the live `profiles` row, not the JWT claim.** A role
  revoked in the database stops applying on the next statement, rather than after
  a Clerk session token refresh.
- **All RPCs in `0004_functions.sql` are `SECURITY INVOKER`.** RLS therefore still
  applies inside them. Marking them `SECURITY DEFINER` would quietly disable the
  entire authorisation model.

---

## Quick start

See **[ARCHITECTURE.md](./ARCHITECTURE.md#setup)** for full setup. In short:

```bash
npm install

# frontend/.env.local
#   VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
#   VITE_SUPABASE_URL=https://<ref>.supabase.co
#   VITE_SUPABASE_ANON_KEY=...
#   VITE_APP_ORIGIN=http://localhost:5173

npm run dev
```

The app renders a "Configuration needed" panel listing the missing variables
rather than failing with a cryptic error, so a fresh clone is self-explanatory.

The anon key is safe in the browser: every table sits behind RLS and an
unauthenticated request resolves to zero rows. **Never** put `service_role` in a
`VITE_` variable.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | typecheck + build + emit `dist/404.html` |
| `npm run typecheck` | shared + frontend |
| `npm test` | shared (permission parity) + frontend |
| `npm run db:migrate` | `supabase db push` |
| `npm run functions:serve` | `supabase functions serve` |

Rate limits match the ceilings the retired Worker enforced, now enforced globally in
Postgres rather than per isolate: 120 marks writes/min, 30 submissions/min,
20 locked-mark corrections/min, 30 uploads/5 min, 20 exports/min, 10 imports/5 min.

---

## Testing

`shared/tests/permissions.seed.test.ts` parses `0003_reference_data.sql` and
asserts the SQL permission matrix matches `ROLE_PERMISSIONS` in TypeScript — for
all three roles, plus that admin holds every catalogue permission and that nothing
unknown has been seeded. RLS is authoritative, so drift is not a security hole,
but it would mean the UI rendering buttons that then fail.

`frontend/src/components/marks/MarkCell.test.tsx` covers the marks cell
interaction and needs no backend.

---

## Project layout

```
frontend/
  src/lib/auth.tsx          Clerk + profiles bridge; four auth states
  src/lib/supabase.ts       Clerk-authenticated Supabase client
  src/lib/permissions.ts    UI-only permission helpers
  src/pages/HomePage.tsx    public landing page at /
  scripts/write-404.mjs     GitHub Pages SPA fallback
shared/
  src/permissions.ts        permission catalogue + role matrix (rendering)
  src/constants.ts          enums mirroring the CHECK constraints
  tests/                    permission-seed parity
supabase/
  migrations/0001_schema      tables
  migrations/0002_rls         authorisation boundary
  migrations/0003_ref         roles + permission matrix + seed data
  migrations/0004_functions   transactional RPCs + grading trigger
  migrations/0005_session     session read model
  migrations/0006_read_views  joined read models
  migrations/0007_rate_limits shared rate-limit counters
  functions/                  14 Edge Functions + _shared/
.github/workflows/deploy.yml  build, test, deploy Pages, push migrations
ARCHITECTURE.md               design, setup, and what remains
```

---

## Licence

See the repository's licence file.