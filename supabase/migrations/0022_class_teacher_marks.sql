-- =============================================================================
-- Class teacher enters all marks for their section
-- =============================================================================
-- Teachers today can mark only the exact (year, class, section, subject) pairs in
-- `teacher_assignments`. The class teacher — the head of the section — was one
-- assignment row, so with six subjects and no subject rows they could enter
-- nothing. A section now has a class teacher, and that teacher can enter marks
-- for every subject taught in their section, not just the ones they happen to be
-- individually assigned to.
--
-- The separation-of-duties model is unchanged: marks approval, review and
-- locking still use their own permissions and is_assigned_to() scopes. Only the
-- *enter marks* gate widens for the class teacher.
--
-- New column
--   sections.class_teacher_id — Clerk user id of the section's class teacher.
--
-- Permission gates that widen
--   public.can_read_sheet   — a class teacher can read their section's sheets
--   public.can_write_sheet  — a class teacher can enter marks for any subject in
--                             their section (still requires marks:edit)
-- =============================================================================

alter table public.sections
  add column if not exists class_teacher_id text;

comment on column public.sections.class_teacher_id is
  'Clerk user id of the teacher responsible for the section. They may enter marks for every subject in it.';

-- The helper is SECURITY DEFINER already (it reads `sections`/`teacher_assignments`
-- regardless of RLS), so an UPDATE from any role is constrained only by the
-- section:manage permission on the table row. That is all we need: the
-- class-teacher relationship is part of section administration.
create or replace function public.is_class_teacher_of(p_section uuid, p_year uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.sections s
      join public.classes c on c.id = s.class_id
     where s.id = p_section
       and s.class_teacher_id = public.current_clerk_id()
       and c.academic_year_id = p_year
  );
$$;

create or replace function public.can_read_sheet(
  p_section uuid,
  p_subject uuid,
  p_year    uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('marks:view_all')
      or public.is_assigned_to(p_section, p_subject, p_year)
      or public.is_class_teacher_of(p_section, p_year);
$$;

create or replace function public.can_write_sheet(
  p_section uuid,
  p_subject uuid,
  p_year    uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('marks:edit')
     and (public.has_permission('marks:view_all')
          or public.is_assigned_to(p_section, p_subject, p_year)
          or public.is_class_teacher_of(p_section, p_year));
$$;
