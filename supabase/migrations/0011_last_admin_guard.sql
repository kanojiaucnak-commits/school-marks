-- =============================================================================
-- Do not let the last administrator be removed
--
-- `profiles_admin_all` grants `user:update` over every profile row, so an
-- administrator can currently demote or deactivate any other administrator —
-- including the only one. There is no in-app way back: self-service provisioning
-- grants `role_teacher`, so a school with no active admin has nobody who can
-- promote anyone, and recovery means direct database access.
--
-- The blast radius is small (it needs two admins cooperating, or one admin making
-- a mistake) but the consequence is total and silent, and it is exactly the kind of
-- irreversible action worth a database-level check rather than a UI one.
--
-- This deliberately does NOT stop an administrator removing a *rogue* colleague:
-- it only refuses when the change would leave the school with no active admin. Two
-- admins can still remove each other, or demote themselves, freely.
-- =============================================================================

create or replace function public.prevent_removing_last_admin()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  was_last_admin boolean;
begin
  -- Only relevant when this row *was* an active administrator.
  if old.role_id <> 'role_admin' or old.status <> 'active' then
    return new;
  end if;

  -- Still one after the change, so nothing to do.
  if new.role_id = 'role_admin' and new.status = 'active' then
    return new;
  end if;

  select not exists (
    select 1
      from public.profiles p
     where p.id <> old.id
       and p.role_id = 'role_admin'
       and p.status = 'active'
  ) into was_last_admin;

  if was_last_admin then
    raise exception
      'This is the only active administrator. Promote someone else to administrator first, '
      'otherwise nobody will be able to manage users, classes or settings.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_no_last_admin on public.profiles;
create trigger trg_profiles_no_last_admin
  before update of role_id, status on public.profiles
  for each row execute function public.prevent_removing_last_admin();