-- =============================================================================
-- A teacher can add a student to their own section
-- =============================================================================
-- `student:create` sat with the admin alone, so the only way a student could
-- arrive was the CSV/Excel import — which runs as the service role and is
-- therefore untouched by any of this. A teacher handed a mid-year joiner's
-- paperwork had no path at all.
--
-- Granting the permission to `role_teacher` on its own would have been wrong in
-- the opposite direction: the `students_insert` policy checked the permission
-- and nothing else, so any teacher could have filed a student into any section
-- in the school. The grant and the narrowing ship together.
--
-- The gate mirrors the read policy in 0008 exactly — the same three callers,
-- evaluated the same way — so a teacher who can see a section is a teacher who
-- can add to it, and no screen is ever offered a button the database refuses.
--
-- Permission grants
--   role_teacher  + student:create
--
-- Permission gates that narrow
--   public.students_insert  — was "holds student:create", now "and the target
--                             section is theirs, or they can see every student"
-- =============================================================================

insert into public.role_permissions (role_id, permission)
select 'role_teacher', p
from unnest(array[
  'student:create'
]) as p
on conflict (role_id, permission) do nothing;

-- SECURITY DEFINER like its siblings: it reads `sections`, `classes` and
-- `teacher_assignments` directly rather than through the caller's RLS.
--
-- The third argument exists because a student row carries class, section and
-- academic year as three independent columns with no constraint tying them
-- together. The form only ever offers a valid triple, but `student:create` is
-- now held by more than one role and the policy is the last place a hand-written
-- request could be stopped from filing a student under someone else's class.
create or replace function public.can_insert_student(
  p_class    uuid,
  p_section  uuid,
  p_year     uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('student:create')
     and (
           public.has_permission('student:view_all')
        or public.is_assigned_to_section(p_section, p_year)
        or public.is_class_teacher_of(p_section, p_year)
     )
     and exists (
           select 1
             from public.sections s
             join public.classes  c on c.id = s.class_id
            where s.id               = p_section
              and s.class_id         = p_class
              and c.academic_year_id = p_year
         );
$$;

grant execute on function public.can_insert_student(uuid, uuid, uuid) to authenticated;

-- Dropped and recreated rather than altered: RLS has no ALTER POLICY.
drop policy if exists students_insert on public.students;

create policy students_insert on public.students
  for insert to authenticated
  with check (
    public.can_insert_student(
      students.class_id,
      students.section_id,
      students.academic_year_id
    )
  );
