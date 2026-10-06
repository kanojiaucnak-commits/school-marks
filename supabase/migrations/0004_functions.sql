-- =============================================================================
-- Transactional RPCs and computed columns
--
-- Why this file exists
-- --------------------
-- The D1 repository layer leaned on `db.batch()` to get atomicity across many
-- statements. supabase-js has no batch API, so every one of those call sites
-- becomes a Postgres function — a function body is a single statement, and hence
-- an implicit transaction.
--
-- These functions are deliberately `SECURITY INVOKER` (the default). RLS
-- therefore still applies to every statement inside them: a teacher calling
-- `save_marks_grid` still cannot touch a row outside their assignments. Using
-- SECURITY DEFINER here would quietly disable the entire authorisation model.
--
-- Grading also moves into the database. Previously `GradingEngine` (a 115-line
-- TypeScript class) computed percentage/grade/grade_point/is_pass in the Worker.
-- Computing it in a BEFORE trigger means no writer — browser, Edge Function or
-- admin script — can persist a mark whose grade disagrees with the active
-- grading scheme.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Active grading scheme
-- -----------------------------------------------------------------------------
create or replace function public.active_scheme_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select id from public.grading_schemes where is_default limit 1),
    (select id from public.grading_schemes order by created_at limit 1)
  );
$$;

-- -----------------------------------------------------------------------------
-- Look up a grade band for a percentage.
-- Port of `lookupGrade()` from worker/src/services/gradingService.ts.
-- Returns no rows when the scheme has a gap, which is treated as "ungraded"
-- rather than silently defaulting to a pass.
-- -----------------------------------------------------------------------------
create or replace function public.grade_for_percentage(p_pct numeric, p_scheme uuid default null)
returns table (grade text, grade_point numeric, is_pass boolean)
language sql stable security definer
set search_path = public
as $$
  select r.grade, r.grade_point, r.is_pass
    from public.grading_rules r
   where r.scheme_id = coalesce(p_scheme, public.active_scheme_id())
     and p_pct >= r.min_percentage
     and p_pct <= r.max_percentage
   limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Derive percentage + grade on every mark write.
--
-- Business rules preserved from the D1 schema:
--   * a non-PRESENT status carries no numeric mark, and therefore no grade;
--   * a PRESENT mark always has a percentage.
-- -----------------------------------------------------------------------------
create or replace function public.marks_derive_grade()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  pct    numeric(5,2);
  scheme uuid;
begin
  if new.status is distinct from 'PRESENT' or new.marks_obtained is null then
    new.percentage  := null;
    new.grade       := null;
    new.grade_point := null;
    new.is_pass     := null;
    return new;
  end if;

  if new.max_marks is null or new.max_marks <= 0 then
    return new;   -- table CHECK will reject this
  end if;

  pct := round((new.marks_obtained / new.max_marks) * 100, 2);
  new.percentage := pct;

  scheme := public.active_scheme_id();
  select g.grade, g.grade_point, g.is_pass
    into new.grade, new.grade_point, new.is_pass
    from public.grade_for_percentage(pct, scheme) g;

  return new;
end;
$$;

drop trigger if exists trg_marks_derive_grade on public.marks;
create trigger trg_marks_derive_grade
  before insert or update of marks_obtained, max_marks, status on public.marks
  for each row execute function public.marks_derive_grade();

-- -----------------------------------------------------------------------------
-- save_marks_grid
--
-- Port of `saveMarksGrid()` (worker/src/services/marksService.ts) plus
-- `getOrCreateSubmission()` and `updateSubmissionWithVersionCheck()`.
--
-- Handles: find-or-create the submission sheet, enforce the optimistic
-- concurrency contract the MarksGrid component depends on (a stale
-- `expected_version` must not clobber a newer sheet), upsert only the rows the
-- teacher actually changed, then refresh the sheet counters.
--
-- Returns a JSON payload rather than raising, because the caller needs to
-- distinguish "version conflict" (409) from "rejected by policy" (403).
-- -----------------------------------------------------------------------------
create or replace function public.save_marks_grid(
  p_section_id       uuid,
  p_subject_id       uuid,
  p_exam_id          uuid,
  p_academic_year_id uuid,
  p_rows             jsonb,
  p_expected_version integer default null,
  p_comments         text     default null
)
returns jsonb
language plpgsql
as $$
declare
  v_submission_id uuid;
  v_class_id      uuid;
  v_version       integer;
  v_status        text;
  v_count         integer;
  v_avg           numeric;
  elem            jsonb;
  v_student       uuid;
  v_marks         numeric;
  v_status_val    text;
  v_remarks       text;
begin
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', true, 'submissionId', null,
                              'version', null, 'enteredCount', 0,
                              'message', 'No changes to save.');
  end if;

  -- Resolve the class via the section; the submission row needs it for the
  -- (year, class, section, subject, exam) uniqueness key.
  select s.class_id into v_class_id
    from public.sections s
   where s.id = p_section_id
     and s.class_id in (select id from public.classes where academic_year_id = p_academic_year_id);

  if v_class_id is null then
    raise exception 'Section % does not belong to academic year %', p_section_id, p_academic_year_id
      using errcode = '23503';
  end if;

  -- Find or create the sheet. ON CONFLICT DO NOTHING then select, so we never
  -- race two concurrent first-time saves.
  insert into public.mark_submissions
    (academic_year_id, class_id, section_id, subject_id, exam_id, teacher_id, status)
  values
    (p_academic_year_id, v_class_id, p_section_id, p_subject_id, p_exam_id,
     public.current_clerk_id(), 'DRAFT')
  on conflict (academic_year_id, class_id, section_id, subject_id, exam_id)
    do nothing;

  select id, version, status into v_submission_id, v_version, v_status
    from public.mark_submissions
   where academic_year_id = p_academic_year_id
     and class_id           = v_class_id
     and section_id         = p_section_id
     and subject_id         = p_subject_id
     and exam_id            = p_exam_id;

  -- A sheet that has been approved or locked is frozen. Editing it requires the
  -- separate `marks:correct_locked` permission, which the RLS policies enforce.
  if v_status in ('APPROVED', 'LOCKED') then
    if not public.has_permission('marks:correct_locked') then
      return jsonb_build_object(
        'ok', false, 'code', 'SUBMISSION_NOT_EDITABLE',
        'message', 'This mark sheet is ' || lower(v_status) ||
                   ' and cannot be edited. Ask a reviewer to lock or return it.');
    end if;
  end if;

  -- Optimistic concurrency: refuse to write over a sheet someone else advanced.
  if p_expected_version is not null and p_expected_version <> v_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CONFLICT',
      'message', 'Someone else updated this mark sheet. Reload to see the latest marks.',
      'version', v_version);
  end if;

  for elem in select * from jsonb_array_elements(p_rows)
  loop
    v_student    := (elem ->> 'studentId')::uuid;
    v_marks      := case when elem ->> 'marks' is null or elem ->> 'marks' = ''
                         then null else (elem ->> 'marks')::numeric end;
    v_status_val := coalesce(elem ->> 'status', 'PRESENT');
    v_remarks    := elem ->> 'remarks';

    -- Ownership of the student row is checked by the `marks` RLS policies on the
    -- UPDATE path; a teacher outside their assignment simply matches nothing.

    insert into public.marks
      (student_id, subject_id, exam_id, academic_year_id, teacher_assignment_id,
       entered_by, max_marks, marks_obtained, status, remarks, source)
    select
      v_student, p_subject_id, p_exam_id, p_academic_year_id,
      (select ta.id from public.teacher_assignments ta
        where ta.teacher_id       = public.current_clerk_id()
          and ta.section_id       = p_section_id
          and ta.subject_id       = p_subject_id
          and ta.academic_year_id = p_academic_year_id
        limit 1),
      public.current_clerk_id(),
      e.max_marks, v_marks, v_status_val, v_remarks, 'manual'
    from public.exams e
    where e.id = p_exam_id
    on conflict (student_id, subject_id, exam_id, academic_year_id)
      do update set
        marks_obtained = excluded.marks_obtained,
        status         = excluded.status,
        remarks        = excluded.remarks,
        entered_by     = public.current_clerk_id(),
        max_marks      = excluded.max_marks;

    -- Enforce the exam ceiling here rather than relying on the client to have
    -- validated it (Business Rule 4).
    if v_marks is not null
       and exists (select 1 from public.exams
                    where id = p_exam_id and v_marks > max_marks) then
      raise exception 'Mark % exceeds the maximum for this exam', v_marks
        using errcode = '22003',
              hint = 'MARK_OUT_OF_RANGE';
    end if;
  end loop;

  -- Refresh the sheet counters from the marks actually stored.
  select count(*) filter (where m.status = 'PRESENT' and m.marks_obtained is not null),
         round(avg(m.marks_obtained) filter (where m.status = 'PRESENT'), 2)
    into v_count, v_avg
    from public.marks m
   where m.academic_year_id = p_academic_year_id
     and m.subject_id       = p_subject_id
     and m.exam_id          = p_exam_id
     and m.student_id in (select id from public.students where section_id = p_section_id);

  -- `version` is deliberately NOT incremented here: the
  -- trg_mark_submissions_bump_version trigger in 0006_read_views.sql assigns
  -- old.version + 1 on every update. Writing `version = version + 1` as well
  -- would rely on the trigger reading `old`, which is correct but confusing to
  -- reason about.
  update public.mark_submissions
     set entered_count  = v_count,
         average_marks  = v_avg,
         total_students = (select count(*) from public.students
                            where section_id = p_section_id
                              and academic_year_id = p_academic_year_id),
         review_comments = coalesce(p_comments, review_comments)
   where id = v_submission_id
  returning version into v_version;

  return jsonb_build_object(
    'ok', true,
    'submissionId', v_submission_id,
    'version', v_version,
    'enteredCount', v_count,
    'average', v_avg,
    'message', format('Saved %s mark(s).', jsonb_array_length(p_rows)));
end;
$$;

-- -----------------------------------------------------------------------------
-- apply_submission_transition
--
-- Port of the DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED -> LOCKED state
-- machine in worker/src/services/submissionService.ts. The legal transitions
-- live in @school/shared as SUBMISSION_TRANSITIONS; they are duplicated here so
-- the database is the final backstop even if a caller skips the shared module.
--
-- Separation of duties is preserved: the teacher who owns a sheet cannot approve
-- or lock it, which the original enforced in `assertTransition`.
-- -----------------------------------------------------------------------------
create or replace function public.apply_submission_transition(
  p_submission_id    uuid,
  p_to               text,
  p_comments         text default null,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
as $$
declare
  v_sub          public.mark_submissions%rowtype;
  v_allowed      text[];
  v_new_version  integer;
begin
  select * into v_sub
    from public.mark_submissions
   where id = p_submission_id
   for update;                     -- serialise concurrent decisions

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
                              'message', 'Mark sheet not found.');
  end if;

  if p_expected_version is not null and p_expected_version <> v_sub.version then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT',
      'message', 'Someone else updated this mark sheet. Reload to see the latest state.',
      'version', v_sub.version);
  end if;

  if p_to = v_sub.status then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION',
      'message', 'This sheet is already ' || lower(v_sub.status) || '.');
  end if;

  v_allowed := case v_sub.status
    when 'DRAFT'     then array['SUBMITTED']
    when 'RETURNED'  then array['SUBMITTED']
    when 'REJECTED'  then array['SUBMITTED']
    when 'SUBMITTED' then array['UNDER_REVIEW', 'APPROVED', 'RETURNED', 'REJECTED']
    when 'UNDER_REVIEW' then array['APPROVED', 'RETURNED', 'REJECTED']
    when 'APPROVED'  then array['LOCKED', 'RETURNED']
    else array[]::text[]
  end;

  if not (p_to = any (v_allowed)) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION',
      'message', format('A sheet cannot go from %s to %s.', v_sub.status, p_to));
  end if;

  -- Returning a sheet for changes requires an explanation.
  if p_to = 'RETURNED' and (p_comments is null or btrim(p_comments) = '') then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'message', 'Explain what needs to change before returning this sheet.');
  end if;

  -- Separation of duties: the teacher who entered the marks may submit them, but
  -- must not review, approve or lock their own sheet.
  if p_to in ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'LOCKED')
     and v_sub.teacher_id = public.current_clerk_id() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN',
      'message', 'You cannot review or lock your own mark sheet.');
  end if;

  -- Every other transition still needs the matching permission. RLS on
  -- mark_submissions backs this up, but checking here gives a clear message.
  if p_to = 'SUBMITTED'      and not public.has_permission('marks:submit')   then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You cannot submit mark sheets.');
  end if;
  if p_to = 'UNDER_REVIEW'  and not public.has_permission('marks:review')  then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You cannot start a review.');
  end if;
  if p_to = 'APPROVED'      and not public.has_permission('marks:approve') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You cannot approve mark sheets.');
  end if;
  if p_to = 'REJECTED'      and not public.has_permission('marks:reject')  then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You cannot reject mark sheets.');
  end if;
  if p_to = 'LOCKED'        and not public.has_permission('marks:lock')    then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You cannot lock mark sheets.');
  end if;

  -- `version` is incremented by trg_mark_submissions_bump_version, not here, so
  -- the number reported back below is read from the row after the update rather
  -- than predicted as old.version + 1.
  update public.mark_submissions
     set status          = p_to,
         review_comments = coalesce(p_comments, review_comments),
         submitted_at    = case when p_to = 'SUBMITTED'     then now() else submitted_at end,
         approved_at     = case when p_to = 'APPROVED'      then now() else approved_at end,
         locked_at       = case when p_to = 'LOCKED'        then now() else locked_at end,
         reviewed_by     = case when p_to in ('UNDER_REVIEW','APPROVED','REJECTED','LOCKED','RETURNED')
                                 then public.current_clerk_id() else reviewed_by end
   where id = p_submission_id
  returning version into v_new_version;

  -- Append-only audit trail for every workflow decision.
  insert into public.audit_logs
    (user_id, action, entity_type, entity_id, old_value, new_value, reason)
  values
    (public.current_clerk_id(), 'submission.' || lower(p_to), 'mark_submission',
     p_submission_id::text,
     jsonb_build_object('status', v_sub.status, 'version', v_sub.version),
     jsonb_build_object('status', p_to, 'version', v_new_version),
     p_comments);

  return jsonb_build_object(
    'ok', true, 'status', p_to, 'version', v_new_version,
    'message', format('Sheet %s.', lower(p_to)));
end;
$$;

-- -----------------------------------------------------------------------------
-- replace_ocr_results
--
-- Port of the delete-then-insert batch in worker/src/db/repositories/ocr.ts.
-- Deleting first and reinserting in one transaction is what prevents a partially
-- updated document from being observable.
-- -----------------------------------------------------------------------------
create or replace function public.replace_ocr_results(
  p_document_id uuid,
  p_results     jsonb
)
returns integer
language plpgsql
as $$
declare
  inserted integer;
begin
  delete from public.ocr_results where document_id = p_document_id;

  insert into public.ocr_results
    (document_id, line_index, raw_text, detected_identifier, detected_name,
     detected_marks, confidence, bbox_page, bbox_x, bbox_y, bbox_width, bbox_height,
     matched_student_id, match_method, match_confidence, match_candidates)
  select
    p_document_id,
    (r ->> 'lineIndex')::integer,
    r ->> 'rawText',
    r ->> 'detectedIdentifier',
    r ->> 'detectedName',
    r ->> 'detectedMarks',
    (r ->> 'confidence')::numeric,
    (r ->> 'bboxPage')::integer,
    (r ->> 'bboxX')::numeric,
    (r ->> 'bboxY')::numeric,
    (r ->> 'bboxWidth')::numeric,
    (r ->> 'bboxHeight')::numeric,
    (r ->> 'matchedStudentId')::uuid,
    coalesce(r ->> 'matchMethod', 'none'),
    (r ->> 'matchConfidence')::numeric,
    r -> 'matchCandidates'
  from jsonb_array_elements(p_results) as r;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- -----------------------------------------------------------------------------
-- save_grading_scheme
--
-- Port of createGradingScheme/updateGradingScheme, where updating a scheme
-- deletes its rules and reinserts them. Doing that without a transaction can
-- leave a scheme with no rules, so it is one function.
-- -----------------------------------------------------------------------------
-- Parameter order matters: Postgres requires that every parameter after one with
-- a default also has a default (SQLSTATE 42P13). So the three required arguments
-- come first and the optional ones follow. Callers pass named arguments, so the
-- order carries no meaning for them.
create or replace function public.save_grading_scheme(
  p_scheme_id     uuid,
  p_name          text,
  p_rules         jsonb,
  p_description   text    default null,
  p_is_default    boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_id       uuid;
  v_was_default boolean;
begin
  if p_scheme_id is null then
    insert into public.grading_schemes (name, description, is_default)
    values (p_name, p_description, p_is_default)
    returning id into v_id;
  else
    select is_default into v_was_default
      from public.grading_schemes
     where id = p_scheme_id
     for update;

    if not found then
      raise exception 'Grading scheme % not found', p_scheme_id using errcode = 'P0002';
    end if;

    update public.grading_schemes
       set name = p_name, description = p_description, is_default = p_is_default
     where id = p_scheme_id
    returning id into v_id;

    -- The partial unique index allows only one default; stand the old one down
    -- inside the same transaction so the swap can never transiently violate it.
    if p_is_default and not v_was_default then
      update public.grading_schemes set is_default = false where id <> v_id and is_default;
    end if;

    delete from public.grading_rules where scheme_id = v_id;
  end if;

  insert into public.grading_rules
    (scheme_id, grade, min_percentage, max_percentage, grade_point, is_pass, sort_order)
  select v_id,
         r ->> 'grade',
         (r ->> 'minPercentage')::numeric,
         (r ->> 'maxPercentage')::numeric,
         (r ->> 'gradePoint')::numeric,
         coalesce((r ->> 'isPass')::boolean, true),
         coalesce((r ->> 'sortOrder')::integer, 0)
    from jsonb_array_elements(p_rules) as r;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- set_default_grading_scheme
--
-- Deliberately NOT implemented as `save_grading_scheme` with the existing rule
-- set: that path deletes every rule and reinserts whatever it is handed, so
-- calling it with an empty list would silently wipe a school's grading bands.
-- Marking a scheme default only moves the flag, in one transaction, so the
-- partial unique index on `is_default` is never transiently violated.
-- -----------------------------------------------------------------------------
create or replace function public.set_default_grading_scheme(p_scheme_id uuid)
returns uuid
language plpgsql
as $$
begin
  if not exists (select 1 from public.grading_schemes where id = p_scheme_id) then
    raise exception 'Grading scheme % not found', p_scheme_id using errcode = 'P0002';
  end if;

  update public.grading_schemes set is_default = false where is_default and id <> p_scheme_id;
  update public.grading_schemes set is_default = true  where id = p_scheme_id;

  return p_scheme_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- has_permission_for / is_assigned_for
--
-- Service-role variants of the identity helpers, for use INSIDE Edge Functions.
--
-- A function runs with the service-role client so it can mint signed URLs, write
-- to Storage and call third-party APIs — and the service role bypasses RLS. These
-- two take the caller explicitly as an argument, so a function can still ask
-- "does *this* user have permission?" without impersonating them.
--
-- The signatures intentionally do NOT default to current_clerk_id(): under the
-- service role `auth.jwt()` is empty, so a defaulted version would silently
-- resolve to NULL and answer "no permission" for everybody. Making the subject
-- explicit means a caller cannot forget it.
-- -----------------------------------------------------------------------------
create or replace function public.has_permission_for(p_user_id text, perm text)
returns boolean
language sql stable
as $$
  select exists (
    select 1
      from public.role_permissions rp
      join public.profiles p on p.role_id = rp.role_id
     where p.id = p_user_id
       and p.status = 'active'
       and rp.permission = perm
  );
$$;

create or replace function public.is_assigned_for(
  p_user_id       text,
  p_section       uuid,
  p_subject       uuid,
  p_year          uuid
)
returns boolean
language sql stable
as $$
  select exists (
    select 1
      from public.teacher_assignments ta
     where ta.teacher_id       = p_user_id
       and ta.section_id       = p_section
       and ta.subject_id       = p_subject
       and ta.academic_year_id = p_year
  );
$$;

-- -----------------------------------------------------------------------------
-- notify_users
--
-- Port of the 500-row bulk insert in worker/src/db/repositories/misc.ts.
-- -----------------------------------------------------------------------
create or replace function public.notify_users(
  p_user_ids text[],
  p_type     text,
  p_title    text,
  p_body     text default null,
  p_link     text default null,
  p_data     jsonb  default null
)
returns integer
language plpgsql
as $$
declare
  inserted integer;
begin
  insert into public.notifications (user_id, type, title, body, link, data)
  select u, p_type, p_title, p_body, p_link, p_data
    from unnest(p_user_ids) as u
  on conflict do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- -----------------------------------------------------------------------------
-- write_audit_log
--
-- The Worker had an `audit()` helper called from ~40 places. Client inserts are
-- permitted by the `audit_logs_append` policy, but a single named function keeps
-- the shape consistent and documents the JSONB contract in one place.
-- -----------------------------------------------------------------------
create or replace function public.write_audit_log(
  p_action      text,
  p_entity_type text,
  p_entity_id   text  default null,
  p_old_value   jsonb default null,
  p_new_value   jsonb default null,
  p_reason      text  default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into public.audit_logs
    (user_id, user_email, action, entity_type, entity_id, old_value, new_value, reason)
  values
    (public.current_clerk_id(),
     (select email::text from public.profiles where id = public.current_clerk_id()),
     p_action, p_entity_type, p_entity_id, p_old_value, p_new_value, p_reason)
  returning id into v_id;

  return v_id;
end;
$$;