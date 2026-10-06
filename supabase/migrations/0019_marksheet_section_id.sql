-- =============================================================================
-- `v_marksheet.section_id` — reports and exports were completely broken
--
-- ── The bug ─────────────────────────────────────────────────────────────────
--
-- Both `report-generate` and `export-generate` filter their marksheet query by
-- section:
--
--     q = q.eq('academic_year_id', academicYearId).eq('section_id', sectionId);
--
-- `v_marksheet` had no `section_id` column. Not a wrong value — the column was
-- absent from the view entirely. PostgREST rejected the request, so:
--
--     Something went wrong
--     Unknown column "section_id" on "v_marksheet".
--
-- That is every subject report, every class report and every marksheet export,
-- on every deployment, since the view was created in 0001_schema.sql. The
-- failing code is reachable and correct-looking, which is why it survived: the
-- reports screen only ever had zero marks to render in this database, so the
-- report body never appeared and there was nothing to compare against.
--
-- ── Why the view had no section ─────────────────────────────────────────────
--
-- The view joins `students` to resolve `class_name` and `section_name` for
-- display, but projected only the *names*:
--
--     c.name  as class_name,
--     sec.name as section_name
--
-- Every consumer of a name also needs the id to filter on. The ids were read off
-- the base tables and discarded, so the one query that needed both display and
-- scope had to go back to the tables it came from — and did not, hence the
-- `Unknown column` error rather than a join.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
--
-- Project `class_id` and `section_id` alongside the names they belong to.
--
-- Additive only: `create or replace view` permits appending columns, and the
-- existing column list and order are unchanged, so no consumer's `select` list
-- breaks. This is why they are appended at the end rather than inserted next to
-- `class_name` where they read more naturally — reordering an existing column is
-- rejected by Postgres, and the alternative is a drop-and-recreate that would
-- take a write lock on a view the app queries on every marks-entry screen.
--
-- ── Security ────────────────────────────────────────────────────────────────
--
-- This view is `security_invoker` (migration 0018), so RLS on `students` now
-- applies to it. `section_id` is therefore filterable but not revealable: a
-- teacher reads only the sections their policies permit, which is the same
-- boundary the section *name* was already subject to.
--
-- Verified: the view definition below, then a live subject report rendered end
-- to end in the browser.
-- =============================================================================

create or replace view public.v_marksheet as
select
  m.*,
  s.full_name        as student_name,
  s.student_number,
  s.roll_number,
  sub.name           as subject_name,
  sub.code           as subject_code,
  e.name             as exam_name,
  e.max_marks        as exam_max_marks,
  c.name             as class_name,
  sec.name           as section_name,
  ay.name            as academic_year_name,
  ms.status          as submission_status,
  ms.id              as submission_id,
  ms.version         as submission_version,
  -- Appended by migration 0019. `section_id` is what `report-generate` and
  -- `export-generate` filter by; `class_id` alongside it so a caller grouping by
  -- class does not have to reach for `classes` separately.
  s.class_id         as class_id,
  s.section_id       as section_id
from public.marks m
join public.students s        on s.id = m.student_id
join public.subjects sub      on sub.id = m.subject_id
join public.exams e           on e.id = m.exam_id
join public.academic_years ay on ay.id = m.academic_year_id
join public.classes c         on c.id = s.class_id
join public.sections sec      on sec.id = s.section_id
left join public.mark_submissions ms
  on ms.section_id       = s.section_id
  and ms.subject_id      = m.subject_id
  and ms.exam_id         = m.exam_id
  and ms.academic_year_id = m.academic_year_id;

-- `create or replace view` does not touch reloptions, but assert it here rather
-- than assume: dropping this would silently reopen the RLS hole in 0018 for the
-- most sensitive view in the schema.
alter view public.v_marksheet set (security_invoker = true);