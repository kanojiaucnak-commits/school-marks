-- =============================================================================
-- `security_invoker` on every read-model view
--
-- ── The vulnerability this closes ───────────────────────────────────────────
--
-- `supabase/migrations/0006_read_views.sql` asserted, in a comment:
--
--     "Every view here is RLS-protected by virtue of the tables it reads: RLS
--      applies to the underlying tables even when they are reached through a
--      view owned by postgres, so a teacher selecting `v_students` still gets
--      exactly the rows their policies permit."
--
-- That is false, and it was the load-bearing assumption of the whole data-access
-- layer. RLS is a property of the table *and the role executing the query*. A
-- view does not propagate that property; it runs with the privileges of its
-- **owner**, and `postgres` has BYPASSRLS.
--
-- Since PostgreSQL 15 the safe behaviour must be requested explicitly with
-- `security_invoker`. Without it, every view silently runs as `postgres`.
--
-- Confirmed on this project's runtime (PostgreSQL 17.11) with a minimal
-- reproduction: one table, one row, `select` policy `using (false)`, reached
-- two ways —
--
--     base_table_rows  plain_view_rows  invoker_view_rows
--                 0                1                   0
--
-- The policy correctly hides the row from the table. The plain view hands it
-- over anyway.
--
-- ── What was actually exposed ───────────────────────────────────────────────
--
-- Verified by impersonating a freshly-registered `role_teacher` with no
-- permissions and no class assignments:
--
--     students via v_students ............ 16
--     students via students ...............  0   <- RLS working correctly
--
-- All 16 students, including `guardian_name`, `guardian_phone` and
-- `date_of_birth` — the entire school roll, readable by an account with zero
-- permissions, through the exact query path the Students page uses. Also
-- leaking: `v_directory` (the staff/user directory, exposing email and role),
-- `v_class_sections` (enrolment counts), `v_grading_schemes`, `v_admin_counts`.
--
-- `anon` held SELECT on every view too, so the same data was readable without
-- an account at all, if the API key were ever exposed.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
--
-- `security_invoker = true` makes the view execute with the privileges of the
-- *invoking* role, so the underlying tables' RLS policies apply exactly as they
-- do on a direct read.
--
-- ── Why no view had it ──────────────────────────────────────────────────────
--
-- Because on Supabase, RLS-on-tables works out of the box and nothing ever
-- prompted. The leak only appears the moment a view is introduced, and it does
-- not fail loudly: every page keeps rendering, and the data looks correct. It is
-- indistinguishable from working code unless you compare a view read against a
-- direct read as the same restricted user — which is what the repro above does.
--
-- ── Blast radius of turning it on ────────────────────────────────────────────
--
-- Genuine: reads through views now honour policies they previously evaded. The
-- application was written *assuming* the policies applied, so its queries were
-- authored against the filtered result set and should keep working. Where a view
-- previously returned rows a policy now hides, that was the leak, not a feature.
--
-- `v_grading_schemes` and `v_admin_counts` deserve a specific note:
-- `v_admin_counts` is a dashboard aggregate and is read by the admin overview
-- only; it reads `students`/`profiles`/`mark_submissions` counts, so a teacher
-- now sees zeros rather than school-wide totals — which is the correct answer,
-- and the admin who has `students:manage` still sees the real numbers.
--
-- Re-verify the read paths after this migration rather than assuming; see the
-- verification queries in the commit.
--
-- ── `security_invoker` and writes ───────────────────────────────────────────
--
-- This only affects SELECT. None of these views are updatable in practice, and
-- no policy in 0002_rls.sql grants insert/update on a view, so write behaviour
-- is unchanged.
--
-- ── Why not `create or replace view` ────────────────────────────────────────
--
-- `security_invoker` is a view *option*, not part of the query, so `ALTER VIEW
-- ... SET (security_invoker = true)` is the correct and minimal statement. It
-- also means the view definitions in 0001/0006 stay untouched and reviewable.
-- =============================================================================

alter view public.v_students                     set (security_invoker = true);
alter view public.v_class_sections               set (security_invoker = true);
alter view public.v_submissions                  set (security_invoker = true);
alter view public.v_teacher_assignments          set (security_invoker = true);
alter view public.v_teacher_assignments_summary  set (security_invoker = true);
alter view public.v_marksheet                    set (security_invoker = true);
alter view public.v_ocr_documents                set (security_invoker = true);
alter view public.v_ocr_results                  set (security_invoker = true);
alter view public.v_grading_schemes              set (security_invoker = true);
alter view public.v_audit_logs                   set (security_invoker = true);
alter view public.v_directory                    set (security_invoker = true);
alter view public.v_admin_counts                 set (security_invoker = true);

-- -----------------------------------------------------------------------------
-- Stop granting these views to `anon`.
--
-- Every policy on the underlying tables is `to authenticated`, so an anonymous
-- read now returns zero rows rather than everything — but a view that only
-- *happens* to be filtered should not be handed to the public role in the first
-- place. The application never reads data as `anon`; that role exists for
-- storage policy evaluation and the auth schema.
-- -----------------------------------------------------------------------------
revoke select on
  public.v_students,
  public.v_class_sections,
  public.v_submissions,
  public.v_teacher_assignments,
  public.v_teacher_assignments_summary,
  public.v_marksheet,
  public.v_ocr_documents,
  public.v_ocr_results,
  public.v_grading_schemes,
  public.v_audit_logs,
  public.v_directory,
  public.v_admin_counts
from anon;

-- -----------------------------------------------------------------------------
-- Correct the comment that caused this.
--
-- Leaving it in place would invite the next person to drop `security_invoker`
-- as redundant, since it reads as a settled finding rather than a superseded
-- guess. `create or replace view` does not reset reloptions, so this note
-- survives — but it is still the first thing anyone reads in this file.
-- -----------------------------------------------------------------------------
comment on view public.v_students is
  'Read model for the Students screens. RLS is enforced on the underlying tables '
  'only because this view is declared security_invoker; see migration 0018 for why '
  'that is not the default and what leaked when it was missing.';

comment on view public.v_marksheet is
  'Marksheet read model. Requires security_invoker for RLS to apply; see migration 0018.';