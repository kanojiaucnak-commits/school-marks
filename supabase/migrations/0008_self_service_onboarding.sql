-- =============================================================================
-- Self-service onboarding
--
-- Until now there was no way for a Clerk user to acquire a `profiles` row.
-- `handle_new_user()` hangs off an `AFTER INSERT ON auth.users` trigger, which
-- only fires for Supabase Auth signups — and this application authenticates with
-- Clerk, so those inserts never happen. The result was that no account could
-- ever sign in: `requireCaller()` throws FORBIDDEN for an unknown Clerk id, and
-- `admin-create-clerk-user` requires an already-provisioned admin to call it.
--
-- This migration closes that loop three ways:
--
--   1. `provision_current_profile()` gives a brand-new Clerk user a teacher
--      profile on first authenticated call.
--   2. `assignment_requests` lets a teacher ask for the classes they teach.
--   3. `students_read` is narrowed so a teacher only sees the sections they are
--      actually assigned to.
--
-- ── Why provisioning is safe ────────────────────────────────────────────────────
-- Provisioning grants `role_teacher`, never `role_admin`, and the role is a
-- literal in the function body. There is deliberately no parameter through which
-- a caller could ask for a different one.
--
-- `role_teacher` on its own grants nothing. Every data-bearing policy funnels
-- through `is_assigned_to()`, which requires a matching `teacher_assignments`
-- row, so a freshly provisioned teacher with zero assignments cannot read or
-- write a single mark. Verified against this database before the migration was
-- written: `can_read_sheet` returned false and `marks` returned no rows.
--
-- What an unassigned teacher *can* read is the reference data they need to make
-- a sensible request: classes, sections and subjects.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
--
-- `student:view_all` follows the pattern already used for marks/ocr/report
-- (`*:view_all` for admin+reviewer, `*:view_assigned` for teacher). Before this
-- there was only a single school-wide `student:view`, which all three roles
-- held — safe when an admin created every account by hand, but not once the
-- public internet can create them.
-- -----------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission)
select r.id, seeds.permission
  from public.roles r
  cross join (values
    ('role_admin',    'student:view_all'),
    ('role_admin',    'assignment:decide'),
    ('role_reviewer', 'student:view_all'),
    ('role_teacher',  'assignment:request')
  ) as seeds(role_id, permission)
 where r.id = seeds.role_id
on conflict (role_id, permission) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Section-scoped helper
-- -----------------------------------------------------------------------------
create or replace function public.is_assigned_to_section(p_section uuid, p_year uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.teacher_assignments ta
     where ta.teacher_id       = public.current_clerk_id()
       and ta.section_id       = p_section
       and ta.academic_year_id = p_year
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. Narrow the student roster
--
-- Dropped and recreated rather than altered: RLS has no ALTER POLICY.
-- -----------------------------------------------------------------------------
drop policy if exists students_read on public.students;

create policy students_read on public.students
  for select to authenticated
  using (
    public.has_permission('student:view_all')
    or (
      public.has_permission('student:view')
      and public.is_assigned_to_section(students.section_id, students.academic_year_id)
    )
  );

-- -----------------------------------------------------------------------------
-- 4. assignment_requests
--
-- A teacher asks for (year, class, section, subject); an admin decides. Approval
-- materialises a real `teacher_assignments` row, which is what every other policy
-- already reads — so granting access stays a single, well-understood mechanism
-- rather than a second parallel one.
-- -----------------------------------------------------------------------------
create table if not exists public.assignment_requests (
  id               uuid primary key default gen_random_uuid(),
  teacher_id       text        not null references public.profiles(id)       on delete cascade,
  academic_year_id uuid        not null references public.academic_years(id) on delete cascade,
  class_id         uuid        not null references public.classes(id)        on delete cascade,
  section_id       uuid        not null references public.sections(id)       on delete cascade,
  subject_id       uuid        not null references public.subjects(id)       on delete cascade,

  status           text        not null default 'pending'
                             check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note             text,

  decided_by       text        references public.profiles(id) on delete set null,
  decided_at       timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One live request per teacher per slot. Partial, so a rejected request can be
-- resubmitted and the history is kept.
create unique index if not exists assignment_requests_one_pending
  on public.assignment_requests (teacher_id, academic_year_id, section_id, subject_id)
  where status = 'pending';

create index if not exists assignment_requests_pending_idx
  on public.assignment_requests (created_at)
  where status = 'pending';

create index if not exists assignment_requests_teacher_idx
  on public.assignment_requests (teacher_id, created_at desc);

drop trigger if exists trg_assignment_requests_updated_at on public.assignment_requests;
create trigger trg_assignment_requests_updated_at
  before update on public.assignment_requests
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Policies
--
-- A teacher sees and cancels their own requests; `assignment:decide` sees and
-- resolves everyone's. Transitions themselves go through the RPCs in §6, which
-- re-check permissions — these policies are the backstop, not the only guard.
-- -----------------------------------------------------------------------------
alter table public.assignment_requests enable row level security;

create policy assignment_requests_read on public.assignment_requests
  for select to authenticated
  using (teacher_id = public.current_clerk_id()
         or public.has_permission('assignment:decide'));

create policy assignment_requests_insert on public.assignment_requests
  for insert to authenticated
  with check (public.has_permission('assignment:request')
              and teacher_id = public.current_clerk_id());

create policy assignment_requests_update on public.assignment_requests
  for update to authenticated
  using (teacher_id = public.current_clerk_id()
         or public.has_permission('assignment:decide'))
  with check (teacher_id = public.current_clerk_id()
              or public.has_permission('assignment:decide'));

-- -----------------------------------------------------------------------------
-- 6. Request a class
--
-- SECURITY INVOKER (the default) on purpose: RLS still applies inside the
-- function, so `assignment_requests_insert` remains the enforcement boundary.
-- -----------------------------------------------------------------------------
create or replace function public.request_assignment(
  p_academic_year_id uuid,
  p_class_id         uuid,
  p_section_id       uuid,
  p_subject_id       uuid
)
returns public.assignment_requests
language plpgsql
set search_path = public
as $$
declare
  v_teacher text := public.current_clerk_id();
  v_row     public.assignment_requests;
begin
  if not public.has_permission('assignment:request') then
    raise exception 'You do not have permission to request classes'
      using errcode = '42501';
  end if;

  if not public.current_clerk_id_is_active() then
    raise exception 'Your account is not active'
      using errcode = '42501';
  end if;

  -- A section belongs to a class, and a class belongs to a year. Passing a
  -- mismatched triple would otherwise create a row that can never be granted,
  -- because `teacher_assignments` is keyed on all five columns.
  if not exists (
    select 1
      from public.sections s
      join public.classes c on c.id = s.class_id
     where s.id = p_section_id
       and c.id = p_class_id
       and c.academic_year_id = p_academic_year_id
  ) then
    raise exception 'That class and section do not belong together'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.subjects sub
     where sub.id = p_subject_id and sub.is_active
  ) then
    raise exception 'That subject is not available'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.teacher_assignments ta
     where ta.teacher_id       = v_teacher
       and ta.academic_year_id = p_academic_year_id
       and ta.section_id       = p_section_id
       and ta.subject_id       = p_subject_id
  ) then
    raise exception 'You are already assigned to that class and subject'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.assignment_requests r
     where r.teacher_id       = v_teacher
       and r.academic_year_id = p_academic_year_id
       and r.section_id       = p_section_id
       and r.subject_id       = p_subject_id
       and r.status           = 'pending'
  ) then
    raise exception 'You have already requested that class and subject'
      using errcode = '22023';
  end if;

  insert into public.assignment_requests
    (teacher_id, academic_year_id, class_id, section_id, subject_id)
  values
    (v_teacher, p_academic_year_id, p_class_id, p_section_id, p_subject_id)
  returning * into v_row;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Approve or reject
--
-- Approving writes the `teacher_assignments` row in the same transaction, so a
-- crash can never leave an approved request without access. The existing UNIQUE
-- constraint on those five columns makes the insert idempotent.
-- -----------------------------------------------------------------------------
create or replace function public.decide_assignment_request(
  p_request_id uuid,
  p_decision    text,
  p_note        text default null
)
returns public.assignment_requests
language plpgsql
set search_path = public
as $$
declare
  v_row public.assignment_requests;
begin
  if not public.has_permission('assignment:decide') then
    raise exception 'You do not have permission to decide class requests'
      using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'Unknown decision'
      using errcode = '22023';
  end if;

  update public.assignment_requests
     set status     = p_decision,
         note       = coalesce(p_note, note),
         decided_by = public.current_clerk_id(),
         decided_at = now()
   where id = p_request_id
     and status = 'pending'
  returning * into v_row;

  -- Guards a double-click: the second UPDATE matches nothing, so v_row is null
  -- rather than silently re-granting.
  if v_row.id is null then
    raise exception 'That request is no longer pending'
      using errcode = '40001';
  end if;

  if p_decision = 'approved' then
    insert into public.teacher_assignments
      (teacher_id, academic_year_id, class_id, section_id, subject_id)
    values
      (v_row.teacher_id, v_row.academic_year_id, v_row.class_id, v_row.section_id, v_row.subject_id)
    on conflict (teacher_id, academic_year_id, class_id, section_id, subject_id) do nothing;
  end if;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Withdraw your own request
-- -----------------------------------------------------------------------------
create or replace function public.cancel_assignment_request(p_request_id uuid)
returns public.assignment_requests
language plpgsql
set search_path = public
as $$
declare
  v_row public.assignment_requests;
begin
  update public.assignment_requests
     set status = 'cancelled', updated_at = now()
   where id = p_request_id
     and teacher_id = public.current_clerk_id()
     and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending request of yours with that id'
      using errcode = '40001';
  end if;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Provision a profile for the caller
--
-- This is the missing link that made sign-in impossible. SECURITY DEFINER
-- because it must insert into `profiles` while the caller holds no privileges
-- there, and because the `profiles` policies would otherwise recurse.
--
-- The subject comes from `current_clerk_id()` — i.e. the verified Clerk `sub` in
-- the JWT — never from a parameter. That is what makes it safe: a caller cannot
-- provision somebody else's row, and cannot pick their own role.
-- -----------------------------------------------------------------------------
create or replace function public.provision_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := public.current_clerk_id();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_email  citext;
  v_name   text;
begin
  if v_id is null then
    raise exception 'Not signed in'
      using errcode = '42501';
  end if;

  v_email := nullif(
    btrim(coalesce(v_claims ->> 'email',
                   v_claims ->> 'primary_email_address',
                   v_claims ->> 'email_address', '')),
    ''
  );

  v_name := nullif(
    btrim(coalesce(
      v_claims ->> 'name',
      v_claims ->> 'full_name',
      nullif(btrim(coalesce(v_claims ->> 'given_name', '') || ' '
                    || coalesce(v_claims ->> 'family_name', '')), ''),
      split_part(coalesce(v_email::text, ''), '@', 1)
    )),
    ''
  );

  if v_email is null then
    raise exception 'Your sign-in provider did not supply an email address, so an account cannot be created'
      using errcode = '22023';
  end if;

  insert into public.profiles (id, email, full_name, role_id, status)
  values (v_id, v_email, coalesce(v_name, 'User'), 'role_teacher', 'active')
  on conflict (id) do nothing;

  -- Clerk owns the email, so keep ours in step with it. Done as a separate
  -- statement: an ON CONFLICT DO UPDATE ... WHERE would need to qualify the
  -- target column, which is awkward and easy to get subtly wrong.
  update public.profiles
     set email = v_email, updated_at = now()
   where id = v_id and email is distinct from v_email;

  return (select p from public.profiles p where p.id = v_id);
end;
$$;

grant execute on function public.provision_current_profile() to authenticated;
grant execute on function public.request_assignment(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.decide_assignment_request(uuid, text, text) to authenticated;
grant execute on function public.cancel_assignment_request(uuid) to authenticated;