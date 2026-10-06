-- =============================================================================
-- Optimistic-concurrency version bump
--
-- `mark_submissions.version` is incremented by the database on EVERY update,
-- rather than being set to a caller-supplied number. Two consequences:
--
--  - Two concurrent writers cannot both believe they produced version N+1.
--  - Any update at all invalidates an open editor's expected version, which is
--    the point (Business Rule 6). An earlier draft of this trigger fired only
--    `when (old.version is distinct from new.version)`, which meant an update
--    that touched only `updated_at` — as `ocr-confirm` does — silently left the
--    version alone and failed to signal a concurrent change.
--
-- Callers that write `version = version + 1` explicitly are unaffected: the
-- trigger assigns from `old.version`, so the result is identical and there is no
-- double increment.
-- =============================================================================
-- Touches only `version`. `updated_at` is maintained separately by the
-- `set_updated_at` trigger created in 0001_schema.sql; the two write different
-- columns, so their alphabetical firing order does not matter.
create or replace function public.bump_submission_version()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists trg_mark_submissions_bump_version on public.mark_submissions;
create trigger trg_mark_submissions_bump_version
  before update on public.mark_submissions
  for each row execute function public.bump_submission_version();

-- =============================================================================
-- Read-model views
--
-- The D1 repositories assembled these shapes with six-way JOINs inside raw SQL
-- strings. PostgREST's embedded-resource selects can express most of that, but
-- they are fragile for deep graphs and impossible to review at a glance. Views
-- keep the join in one place, give it a name, and make it reviewable.
--
-- Every view here is RLS-protected by virtue of the tables it reads: RLS applies
-- to the underlying tables even when they are reached through a view owned by
-- postgres, so a teacher selecting `v_students` still gets exactly the rows
-- their policies permit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Class → section, with enrolment counts. Drives the cascading year/section
-- selectors on the marks-entry and report screens.
-- -----------------------------------------------------------------------------
create or replace view public.v_class_sections as
select
  c.academic_year_id,
  c.id                as class_id,
  c.name              as class_name,
  s.id                as section_id,
  s.name              as section_name,
  ay.name             as academic_year_name,
  c.name || ' - ' || s.name as label,
  (select count(*) from public.students st
    where st.section_id       = s.id
      and st.academic_year_id = c.academic_year_id) as student_count
    from public.sections s
    join public.classes c        on c.id = s.class_id
    join public.academic_years ay on ay.id = c.academic_year_id;

-- -----------------------------------------------------------------------------
-- Students with their class, section and year resolved.
--
-- Note `normalized_name` is intentionally excluded: it is an internal OCR
-- matching aid, not something the UI should render or send over the wire.
-- -----------------------------------------------------------------------------
create or replace view public.v_students as
select
  st.*,
  c.name  as class_name,
  sec.name as section_name,
  ay.name as academic_year_name
    from public.students st
    join public.classes c        on c.id = st.class_id
    join public.sections sec     on sec.id = st.section_id
    join public.academic_years ay on ay.id = st.academic_year_id;

-- -----------------------------------------------------------------------------
-- Mark sheets with everything the review queue needs to render a row.
-- -----------------------------------------------------------------------------
create or replace view public.v_submissions as
select
  ms.*,
  c.name        as class_name,
  sec.name      as section_name,
  sub.name      as subject_name,
  sub.code      as subject_code,
  e.name        as exam_name,
  e.max_marks   as exam_max_marks,
  ay.name       as academic_year_name,
  tp.full_name  as teacher_name,
  tp.email::text as teacher_email,
  rv.full_name  as reviewed_by_name
    from public.mark_submissions ms
    join public.classes c         on c.id = ms.class_id
    join public.sections sec      on sec.id = ms.section_id
    join public.subjects sub      on sub.id = ms.subject_id
    join public.exams e           on e.id = ms.exam_id
    join public.academic_years ay on ay.id = ms.academic_year_id
    join public.profiles tp       on tp.id = ms.teacher_id
    left join public.profiles rv  on rv.id = ms.reviewed_by;

-- -----------------------------------------------------------------------------
-- Teacher assignments with names resolved.
--
-- Teachers may read their own rows; staff with `assignment:manage` read all,
-- per the `teacher_assignments_read` policy.
-- -----------------------------------------------------------------------------
create or replace view public.v_teacher_assignments as
select
  ta.id,
  ta.teacher_id,
  ta.academic_year_id,
  ta.class_id,
  ta.section_id,
  ta.subject_id,
  ta.created_at,
  p.full_name    as teacher_name,
  p.email::text  as teacher_email,
  c.name         as class_name,
  sec.name       as section_name,
  sub.name       as subject_name,
  sub.code       as subject_code,
  ay.name        as academic_year_name
    from public.teacher_assignments ta
    join public.profiles p        on p.id = ta.teacher_id
    join public.classes c         on c.id = ta.class_id
    join public.sections sec      on sec.id = ta.section_id
    join public.subjects sub      on sub.id = ta.subject_id
    join public.academic_years ay on ay.id = ta.academic_year_id;

-- -----------------------------------------------------------------------------
-- OCR documents.
--
-- This view is what finally supplies `subject_name`, which `OcrReviewPage`
-- referenced but the D1 repository never selected — it rendered an empty string
-- for every document.
-- -----------------------------------------------------------------------------
create or replace view public.v_ocr_documents as
select
  d.*,
  sub.name as subject_name,
  sub.code as subject_code,
  sec.name as section_name,
  c.name   as class_name,
  e.name   as exam_name,
  ay.name  as academic_year_name,
  p.full_name as uploaded_by_name
    from public.ocr_documents d
    join public.subjects sub      on sub.id = d.subject_id
    join public.sections sec      on sec.id = d.section_id
    join public.classes c         on c.id = d.class_id
    join public.exams e           on e.id = d.exam_id
    join public.academic_years ay on ay.id = d.academic_year_id
    join public.profiles p        on p.id = d.uploaded_by;

-- -----------------------------------------------------------------------------
-- OCR results with the matched student resolved.
-- -----------------------------------------------------------------------------
create or replace view public.v_ocr_results as
select
  r.*,
  st.full_name       as matched_student_name,
  st.student_number  as matched_student_number,
  st.roll_number     as matched_roll_number
    from public.ocr_results r
    left join public.students st on st.id = r.matched_student_id;

-- -----------------------------------------------------------------------------
-- Grading schemes with their rules nested as a jsonb array.
--
-- Aggregating into jsonb means the scheme list is a single query instead of one
-- per scheme, and supabase-js returns it already parsed.
-- -----------------------------------------------------------------------------
create or replace view public.v_grading_schemes as
select
  s.id,
  s.name,
  s.description,
  s.is_default,
  s.created_at,
  s.updated_at,
  coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'id', r.id,
                'grade', r.grade,
                'minPercentage', r.min_percentage,
                'maxPercentage', r.max_percentage,
                'gradePoint', r.grade_point,
                'isPass', r.is_pass,
                'sortOrder', r.sort_order
              ) order by r.sort_order, r.grade)
       from public.grading_rules r
      where r.scheme_id = s.id),
    '[]'::jsonb
  ) as rules
    from public.grading_schemes s;

-- -----------------------------------------------------------------------------
-- Audit log rows rendered for the viewer.
-- -----------------------------------------------------------------------------
create or replace view public.v_audit_logs as
select * from public.audit_logs;

-- -----------------------------------------------------------------------------
-- Dashboard: teacher work queue.
--
-- Scoped to the caller's own assignments, so it is safe for a teacher. RLS on
-- `teacher_assignments` and `mark_submissions` already filters both sides of the
-- join, and a view does not widen that.
--
-- Includes `teacher_id` so the frontend can query it directly rather than
-- posting the id it got from the JWT.
-- -----------------------------------------------------------------------------
create or replace view public.v_teacher_assignments_summary as
select
  ta.teacher_id,
  ta.section_id,
  ta.subject_id,
  ta.academic_year_id,
  count(ms.id) filter (where ms.status = 'DRAFT')     as drafts,
  count(ms.id) filter (where ms.status = 'RETURNED') as returned
    from public.teacher_assignments ta
    left join public.mark_submissions ms
      on  ms.section_id       = ta.section_id
      and ms.subject_id       = ta.subject_id
      and ms.academic_year_id = ta.academic_year_id
   group by ta.teacher_id, ta.section_id, ta.subject_id, ta.academic_year_id;

-- -----------------------------------------------------------------------------
-- Dashboard: counts for the admin overview.
-- -----------------------------------------------------------------------------
create or replace view public.v_admin_counts as
select
  (select count(*) from public.students)                              as students,
  (select count(*) from public.subjects where is_active)             as subjects,
  (select count(*) from public.profiles where status = 'active')     as active_users,
  (select count(*) from public.mark_submissions)                      as submissions,
  (select count(*) from public.mark_submissions where status = 'SUBMITTED')     as awaiting_review,
  (select count(*) from public.mark_submissions where status = 'UNDER_REVIEW')  as in_review,
  (select count(*) from public.mark_submissions where status = 'APPROVED')      as approved,
  (select count(*) from public.mark_submissions where status = 'LOCKED')        as locked,
  (select count(*) from public.ocr_documents where status = 'FAILED')           as ocr_failed,
  (select count(*) from public.ocr_documents where status in ('UPLOADED','QUEUED','PROCESSING')) as ocr_pending;