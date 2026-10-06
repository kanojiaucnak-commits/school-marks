-- =============================================================================
-- "Out of" marks is now per sheet, not one number per exam
--
-- Every mark had to satisfy a single `exams.max_marks`, which is the cap for the
-- exam as a whole. Schools do not work that way: a Term 1 Physics paper in front
-- of Class 12 may be out of 70 while the Commerce English paper the same term is
-- out of 100, and in Class 9 the same subject may be out of a different total
-- again. One exam-level number forced all subjects of the whole school into a
-- single maximum.
--
-- What changed: a sheet — the unit `(academic year, class, section, subject,
-- exam)` — can now carry its own `max_marks`. The exam's number remains the
-- default, so nothing changes until somebody sets an override, and in practice
-- the override lives for the sheets where the subject genuinely differs.
--
-- The resolution order is used everywhere: an explicit sheet override wins;
-- otherwise the exam's own `max_marks`.
--
-- * `save_marks_grid` stores the effective maximum on each mark it writes and
--   enforces it as the ceiling (Business Rule 4 moved too).
-- * `getMarksGrid` shows the effective maximum in the marks entry grid.
-- * `ocr-confirm` writes the effective maximum to OCR-created marks.
--
-- Reports and exports were already fine: they read the frozen `marks.max_marks`
-- from each row, which is the value in force when the mark was entered.
-- =============================================================================

create table if not exists public.sheet_max_marks (
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  class_id         uuid not null references public.classes(id)      on delete cascade,
  section_id       uuid not null references public.sections(id)     on delete cascade,
  subject_id       uuid not null references public.subjects(id)     on delete cascade,
  exam_id          uuid not null references public.exams(id)        on delete cascade,
  max_marks        numeric not null check (max_marks > 0),
  author_user_id   text,
  updated_at       timestamptz not null default now(),
  primary key (academic_year_id, section_id, subject_id, exam_id)
);

comment on table public.sheet_max_marks is
  'An explicit "out of" override for one sheet. Rows absent here fall back to the exam default.';

alter table public.sheet_max_marks enable row level security;

drop policy if exists sheet_max_marks_read   on public.sheet_max_marks;
drop policy if exists sheet_max_marks_insert on public.sheet_max_marks;
drop policy if exists sheet_max_marks_update on public.sheet_max_marks;
drop policy if exists sheet_max_marks_delete on public.sheet_max_marks;
create policy sheet_max_marks_read on public.sheet_max_marks
  for select to authenticated
  using (public.can_read_sheet(section_id, subject_id, academic_year_id));

create policy sheet_max_marks_insert on public.sheet_max_marks
  for insert to authenticated
  with check (public.can_write_sheet(section_id, subject_id, academic_year_id));

create policy sheet_max_marks_update on public.sheet_max_marks
  for update to authenticated
  using (public.can_write_sheet(section_id, subject_id, academic_year_id))
  with check (public.can_write_sheet(section_id, subject_id, academic_year_id));

create policy sheet_max_marks_delete on public.sheet_max_marks
  for delete to authenticated
  using (public.can_write_sheet(section_id, subject_id, academic_year_id));

grant select, insert, update, delete on public.sheet_max_marks to authenticated;

-- -----------------------------------------------------------------------------
-- Resolve the effective out-of for a sheet: override first, exam default after.
-- -----------------------------------------------------------------------------
create or replace function public.effective_max_marks(
  p_academic_year_id uuid,
  p_section_id       uuid,
  p_subject_id       uuid,
  p_exam_id          uuid
) returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select sm.max_marks from public.sheet_max_marks sm
      where sm.academic_year_id = p_academic_year_id
        and sm.section_id       = p_section_id
        and sm.subject_id       = p_subject_id
        and sm.exam_id          = p_exam_id),
    (select e.max_marks from public.exams e where e.id = p_exam_id)
  );
$$;

comment on function public.effective_max_marks(uuid, uuid, uuid, uuid) is
  'The maximum marks for a sheet: a per-sheet override when one is set, otherwise the exam''s own ceiling.';

-- -----------------------------------------------------------------------------
-- `save_marks_grid` must write and enforce the effective maximum.
-- -----------------------------------------------------------------------------

create or replace function public.save_marks_grid(
  p_section_id       uuid,
  p_subject_id       uuid,
  p_exam_id          uuid,
  p_academic_year_id uuid,
  p_rows             jsonb,
  p_expected_version integer default null,
  p_comments         text    default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_submission_id uuid;
  v_class_id      uuid;
  v_version       integer;
  v_status        text;
  v_count         integer;
  v_avg           numeric;
  v_max_marks     numeric;
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

  v_max_marks := public.effective_max_marks(p_academic_year_id, p_section_id, p_subject_id, p_exam_id);

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

  -- Validate before any row is written. The table's own `chk_marks_within_max`
  -- guard would reject the same rows, but with a bare constraint message; the
  -- teacher should see "Mark 81 exceeds the maximum for this sheet (60)".
  for elem in select * from jsonb_array_elements(p_rows)
  loop
    v_marks := case when elem ->> 'marks' is null or elem ->> 'marks' = ''
                    then null else (elem ->> 'marks')::numeric end;
    if v_marks is not null
       and v_max_marks is not null
       and v_marks > v_max_marks then
      raise exception 'Mark % exceeds the maximum for this sheet (%)', v_marks, v_max_marks
        using errcode = '22003',
              hint = 'MARK_OUT_OF_RANGE';
    end if;
  end loop;

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
      v_max_marks, v_marks, v_status_val, v_remarks, 'manual'
    on conflict (student_id, subject_id, exam_id, academic_year_id)
      do update set
        marks_obtained = excluded.marks_obtained,
        status         = excluded.status,
        remarks        = excluded.remarks,
        entered_by     = public.current_clerk_id(),
        max_marks      = excluded.max_marks;

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
