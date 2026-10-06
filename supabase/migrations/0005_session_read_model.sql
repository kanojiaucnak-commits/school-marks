-- =============================================================================
-- Session read model
--
-- The frontend needs exactly three things after sign-in: who am I, what role do
-- I have, and what may I do. Fetching that as three queries (profiles, roles,
-- role_permissions) would be three round trips on every page load, so it is one
-- function that returns a `CurrentUser`-shaped jsonb payload.
--
-- The shape deliberately matches `CurrentUser` in `shared/src/types.ts` so the
-- React layer can consume it without a column-by-column mapping layer.
--
-- `mustChangePassword` is intentionally absent: Clerk owns password policy, and
-- the old ForcePasswordChangeGate is replaced by Clerk's own reset flow.
-- =============================================================================

create or replace function public.my_permissions()
returns text[]
language sql stable security definer
set search_path = public
as $$
  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::text[])
    from public.role_permissions rp
    join public.profiles p on p.role_id = rp.role_id
   where p.id = public.current_clerk_id()
     and p.status = 'active';
$$;

create or replace function public.my_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select r.name
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where p.id = public.current_clerk_id()
     and p.status = 'active';
$$;

/**
 * Returns null when there is no active profile, which is the frontend's signal to
 * show an "account not provisioned" screen rather than treat the user as an
 * anonymous stranger.
 */
create or replace function public.my_profile()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',         p.id,
    'email',      p.email::text,
    'fullName',   p.full_name,
    'username',   p.username::text,
    'role',       r.name,
    'roleId',     p.role_id,
    'employeeCode', p.employee_code::text,
    'phone',      p.phone,
    'status',     p.status,
    'permissions', public.my_permissions(),
    'lastLoginAt', p.last_login_at
  )
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where p.id = public.current_clerk_id()
     and p.status = 'active';
$$;

-- Update the last-seen timestamp. Called once after sign-in rather than on every
-- request, so it is cheap and still gives a useful "who has been active" signal.
create or replace function public.touch_last_login()
returns void
language sql security definer
set search_path = public
as $$
  update public.profiles set last_login_at = now() where id = public.current_clerk_id();
$$;

-- -----------------------------------------------------------------------------
-- Directory view for the admin Teachers page, mirroring the `User` shape
-- previously assembled by worker/src/db/repositories/users.ts.
-- -----------------------------------------------------------------------------
create or replace view public.v_directory as
select
  p.id,
  p.email::text                    as email,
  p.full_name                      as full_name,
  p.username::text                 as username,
  r.name                           as role,
  p.role_id,
  p.employee_code::text            as employee_code,
  p.phone,
  p.status,
  p.last_login_at,
  p.created_at,
  p.updated_at,
  (select count(*) from public.teacher_assignments ta where ta.teacher_id = p.id)
                                  as assigned_class_count
    from public.profiles p
    join public.roles r on r.id = p.role_id;